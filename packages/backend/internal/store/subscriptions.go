package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

// Subscription mirrors meo.subscriptions. tier defaults to 'free' if
// no row exists for the user yet (handled by the store, not the SQL).
type Subscription struct {
	UserID             string
	Tier               string  // 'free' | 'hobbyist' | 'business' | 'enterprise'
	Source             *string // 'paddle' | 'revenuecat' | 'manual' | nil
	ExternalID         *string
	CurrentPeriodEnd   *time.Time
	CancelAtPeriodEnd  bool
	Raw                json.RawMessage
	UpdatedAt          time.Time
}

type SubscriptionStore struct{ db *sql.DB }

// Get returns the subscription row, or a synthesized free-tier row if
// none exists yet. Never returns ErrNotFound — every authenticated
// user is at least 'free'.
func (s *SubscriptionStore) Get(userID string) (*Subscription, error) {
	row := s.db.QueryRow(
		`SELECT user_id::text, tier, source, external_id, current_period_end,
		        cancel_at_period_end, raw, updated_at
		   FROM meo.subscriptions WHERE user_id = $1::uuid`,
		userID,
	)
	var sub Subscription
	var source, externalID sql.NullString
	var cpe sql.NullTime
	var raw sql.NullString
	if err := row.Scan(&sub.UserID, &sub.Tier, &source, &externalID, &cpe,
		&sub.CancelAtPeriodEnd, &raw, &sub.UpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return &Subscription{
				UserID:    userID,
				Tier:      "free",
				UpdatedAt: time.Now(),
			}, nil
		}
		return nil, err
	}
	if source.Valid {
		sub.Source = &source.String
	}
	if externalID.Valid {
		sub.ExternalID = &externalID.String
	}
	if cpe.Valid {
		t := cpe.Time
		sub.CurrentPeriodEnd = &t
	}
	if raw.Valid {
		sub.Raw = json.RawMessage(raw.String)
	}
	return &sub, nil
}

// SetTier upserts the tier for a user. Called from billing webhooks
// (not yet wired) and from the manual /admin path. Source stamps how
// the change was made for audit.
func (s *SubscriptionStore) SetTier(userID, tier, source string, currentPeriodEnd *time.Time) error {
	_, err := s.db.Exec(
		`INSERT INTO meo.subscriptions (user_id, tier, source, current_period_end, updated_at)
		 VALUES ($1::uuid, $2, $3, $4, now())
		 ON CONFLICT (user_id) DO UPDATE
		   SET tier = EXCLUDED.tier,
		       source = EXCLUDED.source,
		       current_period_end = EXCLUDED.current_period_end,
		       updated_at = now()`,
		userID, tier, source, currentPeriodEnd,
	)
	return translatePgError(err)
}

// TierLimits encodes the per-tier device cap, attachment cap, and
// total storage cap. Mirrors the values the Supabase SQL functions
// return so behavior is identical between the two backends.
type TierLimits struct {
	DeviceCap          int
	MaxAttachmentBytes int64
	StorageCapBytes    int64
}

// Limits returns the resource limits for a tier name. Falls back to
// the 'free' tier if an unknown tier slips through (defense-in-depth).
func Limits(tier string) TierLimits {
	switch tier {
	case "hobbyist":
		return TierLimits{DeviceCap: 5, MaxAttachmentBytes: 25 * 1024 * 1024, StorageCapBytes: 5 * 1024 * 1024 * 1024}
	case "business":
		return TierLimits{DeviceCap: 25, MaxAttachmentBytes: 100 * 1024 * 1024, StorageCapBytes: 50 * 1024 * 1024 * 1024}
	case "enterprise":
		return TierLimits{DeviceCap: 250, MaxAttachmentBytes: 500 * 1024 * 1024, StorageCapBytes: 500 * 1024 * 1024 * 1024}
	default: // free
		return TierLimits{DeviceCap: 2, MaxAttachmentBytes: 10 * 1024 * 1024, StorageCapBytes: 100 * 1024 * 1024}
	}
}
