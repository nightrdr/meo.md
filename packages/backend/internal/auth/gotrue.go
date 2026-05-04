package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// GoTrueClient is a thin HTTP wrapper around the local Supabase Auth
// (a.k.a. GoTrue) instance. We don't shell out to supabase-js or any
// SDK — the wire format is well-defined and stable.
//
// Endpoints we use:
//   POST /auth/v1/otp                            — send email OTP
//   POST /auth/v1/verify                         — verify OTP, get session
//   POST /auth/v1/token?grant_type=refresh_token — refresh access token
//   POST /auth/v1/logout                         — revoke refresh token
//   POST /auth/v1/signup                         — password signup (legacy)
//   POST /auth/v1/token?grant_type=password      — password login (legacy)
type GoTrueClient struct {
	baseURL string // http://127.0.0.1:54321 (no trailing slash)
	apiKey  string // SUPABASE_ANON_KEY — required for the apikey header
	hc      *http.Client
}

// NewGoTrueClient validates the inputs and returns a ready-to-use
// client. baseURL must not end in /auth/v1 — we append the path.
func NewGoTrueClient(baseURL, apiKey string) (*GoTrueClient, error) {
	if baseURL == "" {
		return nil, errors.New("gotrue: empty baseURL")
	}
	if apiKey == "" {
		return nil, errors.New("gotrue: empty apiKey")
	}
	return &GoTrueClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		apiKey:  apiKey,
		hc:      &http.Client{Timeout: 30 * time.Second},
	}, nil
}

// Session is the {access_token, refresh_token, user.id} triple
// returned by /verify and /token. Field names match GoTrue's wire
// format — don't rename without updating the response decoder.
type Session struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int    `json:"expires_in"`
	ExpiresAt    int64  `json:"expires_at"`
	User         struct {
		ID    string `json:"id"`
		Email string `json:"email"`
	} `json:"user"`
}

// gtError is GoTrue's standard error envelope. Bubbled up unchanged
// in our APIError so callers see the same code/msg the upstream sent.
type gtError struct {
	Status  int    `json:"-"`
	Code    string `json:"error_code,omitempty"`
	Code2   string `json:"code,omitempty"`   // newer field name
	Msg     string `json:"msg,omitempty"`
	Message string `json:"message,omitempty"`
	Error_  string `json:"error,omitempty"`
}

// APIError is what callers get back from GoTrue calls. Carries the
// HTTP status and the upstream error message so handlers can decide
// whether to surface it verbatim or map to a friendlier message.
type APIError struct {
	Status  int
	Code    string
	Message string
}

func (e *APIError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("gotrue %d %s: %s", e.Status, e.Code, e.Message)
	}
	return fmt.Sprintf("gotrue %d: %s", e.Status, e.Message)
}

// RequestOTP sends a 6-digit code to the email. shouldCreateUser
// matches GoTrue's flag — true = signup-on-first-OTP, false = only
// existing users get a code.
func (c *GoTrueClient) RequestOTP(ctx context.Context, email string, shouldCreateUser bool) error {
	body, _ := json.Marshal(map[string]any{
		"email":              email,
		"create_user":        shouldCreateUser,
		"should_create_user": shouldCreateUser, // newer GoTrue field
	})
	resp, err := c.do(ctx, http.MethodPost, "/auth/v1/otp", body, "")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return decodeError(resp)
	}
	return nil
}

// VerifyOTP exchanges email+token for a Session.
func (c *GoTrueClient) VerifyOTP(ctx context.Context, email, token string) (*Session, error) {
	body, _ := json.Marshal(map[string]string{
		"email": email,
		"token": token,
		"type":  "email",
	})
	resp, err := c.do(ctx, http.MethodPost, "/auth/v1/verify", body, "")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, decodeError(resp)
	}
	var s Session
	if err := json.NewDecoder(resp.Body).Decode(&s); err != nil {
		return nil, fmt.Errorf("decode session: %w", err)
	}
	return &s, nil
}

// Refresh exchanges a refresh_token for a new access/refresh pair.
// GoTrue rotates the refresh_token on every call; reuse of an old one
// is detected as theft and revokes the entire chain.
func (c *GoTrueClient) Refresh(ctx context.Context, refreshToken string) (*Session, error) {
	body, _ := json.Marshal(map[string]string{"refresh_token": refreshToken})
	resp, err := c.do(ctx, http.MethodPost, "/auth/v1/token?grant_type=refresh_token", body, "")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, decodeError(resp)
	}
	var s Session
	if err := json.NewDecoder(resp.Body).Decode(&s); err != nil {
		return nil, fmt.Errorf("decode session: %w", err)
	}
	return &s, nil
}

// Logout revokes the user's refresh token. Pass the access token in
// the Authorization header so GoTrue knows whose session to nuke.
func (c *GoTrueClient) Logout(ctx context.Context, accessToken string) error {
	resp, err := c.do(ctx, http.MethodPost, "/auth/v1/logout", []byte("{}"), accessToken)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 && resp.StatusCode != http.StatusNotFound {
		return decodeError(resp)
	}
	return nil
}

// PasswordSignup creates a user with email + password. Used by the
// e2e tests and the legacy signup path; the desktop UI prefers OTP.
func (c *GoTrueClient) PasswordSignup(ctx context.Context, email, password string) (*Session, error) {
	body, _ := json.Marshal(map[string]string{"email": email, "password": password})
	resp, err := c.do(ctx, http.MethodPost, "/auth/v1/signup", body, "")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, decodeError(resp)
	}
	var s Session
	if err := json.NewDecoder(resp.Body).Decode(&s); err != nil {
		return nil, fmt.Errorf("decode session: %w", err)
	}
	return &s, nil
}

// PasswordLogin exchanges email + password for a Session.
func (c *GoTrueClient) PasswordLogin(ctx context.Context, email, password string) (*Session, error) {
	body, _ := json.Marshal(map[string]string{"email": email, "password": password})
	resp, err := c.do(ctx, http.MethodPost, "/auth/v1/token?grant_type=password", body, "")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, decodeError(resp)
	}
	var s Session
	if err := json.NewDecoder(resp.Body).Decode(&s); err != nil {
		return nil, fmt.Errorf("decode session: %w", err)
	}
	return &s, nil
}

// do is the lowest-level HTTP wrapper. Adds the apikey header on
// every call (GoTrue requires it even for authenticated routes) and
// optionally a bearer access token.
func (c *GoTrueClient) do(ctx context.Context, method, path string, body []byte, accessToken string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("apikey", c.apiKey)
	req.Header.Set("Content-Type", "application/json")
	if accessToken != "" {
		req.Header.Set("Authorization", "Bearer "+accessToken)
	}
	return c.hc.Do(req)
}

func decodeError(resp *http.Response) error {
	body, _ := io.ReadAll(resp.Body)
	var ge gtError
	_ = json.Unmarshal(body, &ge)
	msg := ge.Msg
	if msg == "" {
		msg = ge.Message
	}
	if msg == "" {
		msg = ge.Error_
	}
	if msg == "" {
		msg = strings.TrimSpace(string(body))
	}
	code := ge.Code
	if code == "" {
		code = ge.Code2
	}
	return &APIError{Status: resp.StatusCode, Code: code, Message: msg}
}
