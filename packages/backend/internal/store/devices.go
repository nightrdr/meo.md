package store

import (
	"database/sql"
	"errors"
	"time"
)

// Device is one row in meo.devices — a registered client install.
type Device struct {
	UserID      string
	DeviceID    string
	Name        string
	Platform    string
	UA          *string
	IP          *string
	FirstSeenAt time.Time
	LastSeen    time.Time
}

type DeviceStore struct{ db *sql.DB }

// Register upserts the row keyed by (user_id, device_id). On
// re-register it bumps last_seen and overwrites name/platform/ua.
// The device-cap check (Pri tier limits) is enforced separately by
// the handler before calling this — see handlers_devices.go.
func (s *DeviceStore) Register(userID, deviceID, platform, name string, ua, ip *string) error {
	_, err := s.db.Exec(
		`INSERT INTO meo.devices (user_id, device_id, name, platform, ua, ip, first_seen_at, last_seen)
		 VALUES ($1::uuid, $2, $3, $4, $5, $6, now(), now())
		 ON CONFLICT (user_id, device_id) DO UPDATE
		   SET name = EXCLUDED.name,
		       platform = EXCLUDED.platform,
		       ua = COALESCE(EXCLUDED.ua, meo.devices.ua),
		       ip = COALESCE(EXCLUDED.ip, meo.devices.ip),
		       last_seen = now()`,
		userID, deviceID, name, platform, ua, ip,
	)
	return translatePgError(err)
}

// List returns the user's devices, newest-first by last_seen.
func (s *DeviceStore) List(userID string) ([]*Device, error) {
	rows, err := s.db.Query(
		`SELECT user_id::text, device_id, name, platform, ua, ip, first_seen_at, last_seen
		   FROM meo.devices
		  WHERE user_id = $1::uuid
		  ORDER BY last_seen DESC`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Device
	for rows.Next() {
		var d Device
		var ua, ip sql.NullString
		if err := rows.Scan(&d.UserID, &d.DeviceID, &d.Name, &d.Platform, &ua, &ip, &d.FirstSeenAt, &d.LastSeen); err != nil {
			return nil, err
		}
		if ua.Valid {
			d.UA = &ua.String
		}
		if ip.Valid {
			d.IP = &ip.String
		}
		out = append(out, &d)
	}
	return out, rows.Err()
}

// Count returns the number of devices currently registered for the user.
// Used by the device-cap check before Register accepts a new device.
func (s *DeviceStore) Count(userID string) (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM meo.devices WHERE user_id = $1::uuid`, userID).Scan(&n)
	return n, err
}

// HasDevice reports whether (user_id, device_id) already exists. Used
// by Register's caller to differentiate "fresh register" from "renew"
// for cap checks.
func (s *DeviceStore) HasDevice(userID, deviceID string) (bool, error) {
	var n int
	err := s.db.QueryRow(
		`SELECT 1 FROM meo.devices WHERE user_id = $1::uuid AND device_id = $2`,
		userID, deviceID,
	).Scan(&n)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// Revoke deletes the row. Used by the Devices pane's sign-out button
// and by sign-out flows on the device itself.
func (s *DeviceStore) Revoke(userID, deviceID string) error {
	res, err := s.db.Exec(
		`DELETE FROM meo.devices WHERE user_id = $1::uuid AND device_id = $2`,
		userID, deviceID,
	)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}
