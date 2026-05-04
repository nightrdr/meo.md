package api

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"meo.md/backend/internal/auth"
)

// requestOTP forwards to GoTrue's /auth/v1/otp endpoint. Rate-limiting
// and abuse mitigation are the upstream's job.
func (s *Server) requestOTP(c *gin.Context) {
	var req otpRequestRequest
	if err := c.ShouldBindJSON(&req); err != nil || req.Email == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "email required"})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
	defer cancel()
	if err := s.gotrue.RequestOTP(ctx, strings.TrimSpace(req.Email), true); err != nil {
		writeAuthError(c, err)
		return
	}
	c.JSON(http.StatusOK, otpRequestResponse{Sent: true})
}

// verifyOTP exchanges a code for an access + refresh token, then
// looks up whether the user already has an account row so the
// desktop can route to passphrase vs. setup screens in one trip.
func (s *Server) verifyOTP(c *gin.Context) {
	var req otpVerifyRequest
	if err := c.ShouldBindJSON(&req); err != nil || req.Email == "" || req.Token == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "email and token required"})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
	defer cancel()
	sess, err := s.gotrue.VerifyOTP(ctx, strings.TrimSpace(req.Email), strings.TrimSpace(req.Token))
	if err != nil {
		writeAuthError(c, err)
		return
	}
	hasAccount, _ := s.store.Accounts.Exists(sess.User.ID)
	c.JSON(http.StatusOK, authLoginResponse{
		JWT:          sess.AccessToken,
		UserID:       sess.User.ID,
		HasAccount:   hasAccount,
		RefreshToken: sess.RefreshToken,
	})
}

// refresh exchanges a refresh_token for a new access + refresh pair.
// GoTrue rotates refresh tokens; the desktop persists the new one and
// drops the old one as soon as this returns.
func (s *Server) refresh(c *gin.Context) {
	var req refreshRequest
	if err := c.ShouldBindJSON(&req); err != nil || req.RefreshToken == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "refresh_token required"})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
	defer cancel()
	sess, err := s.gotrue.Refresh(ctx, req.RefreshToken)
	if err != nil {
		writeAuthError(c, err)
		return
	}
	hasAccount, _ := s.store.Accounts.Exists(sess.User.ID)
	c.JSON(http.StatusOK, authLoginResponse{
		JWT:          sess.AccessToken,
		UserID:       sess.User.ID,
		HasAccount:   hasAccount,
		RefreshToken: sess.RefreshToken,
	})
}

// logout revokes the current session's refresh token. Authed —
// without a valid JWT we don't know whose session to nuke.
func (s *Server) logout(c *gin.Context) {
	bearer := stripBearer(c.GetHeader("Authorization"))
	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()
	if err := s.gotrue.Logout(ctx, bearer); err != nil {
		writeAuthError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// passwordSignup is the legacy e2e signup path. Most users go through
// requestOTP/verifyOTP; this is here so existing test scripts and
// non-interactive integrations keep working.
func (s *Server) passwordSignup(c *gin.Context) {
	var req passwordRequest
	if err := c.ShouldBindJSON(&req); err != nil || req.Email == "" || len(req.Password) < 8 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "email and password (>=8 chars) required"})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
	defer cancel()
	sess, err := s.gotrue.PasswordSignup(ctx, strings.TrimSpace(req.Email), req.Password)
	if err != nil {
		writeAuthError(c, err)
		return
	}
	c.JSON(http.StatusOK, authLoginResponse{
		JWT:          sess.AccessToken,
		UserID:       sess.User.ID,
		RefreshToken: sess.RefreshToken,
	})
}

// passwordLogin: same legacy path for non-OTP login.
func (s *Server) passwordLogin(c *gin.Context) {
	var req passwordRequest
	if err := c.ShouldBindJSON(&req); err != nil || req.Email == "" || req.Password == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "email and password required"})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
	defer cancel()
	sess, err := s.gotrue.PasswordLogin(ctx, strings.TrimSpace(req.Email), req.Password)
	if err != nil {
		writeAuthError(c, err)
		return
	}
	hasAccount, _ := s.store.Accounts.Exists(sess.User.ID)
	c.JSON(http.StatusOK, authLoginResponse{
		JWT:          sess.AccessToken,
		UserID:       sess.User.ID,
		HasAccount:   hasAccount,
		RefreshToken: sess.RefreshToken,
	})
}

// claimsFor pulls the verified JWT claims out of the context. Called
// from every authed handler. Asserts because requireAuth would have
// short-circuited if the value were missing.
func claimsFor(c *gin.Context) *auth.Claims {
	return c.MustGet(claimsKey).(*auth.Claims)
}

// writeAuthError maps a gotrue.APIError into a 4xx response with the
// upstream's status. Anything else is a 502 (couldn't reach GoTrue).
func writeAuthError(c *gin.Context, err error) {
	var apiErr *auth.APIError
	if errors.As(err, &apiErr) {
		status := apiErr.Status
		if status < 400 || status >= 600 {
			status = http.StatusUnauthorized
		}
		body := gin.H{"error": apiErr.Message}
		if apiErr.Code != "" {
			body["code"] = apiErr.Code
		}
		c.JSON(status, body)
		return
	}
	c.JSON(http.StatusBadGateway, gin.H{"error": "auth backend unreachable", "detail": err.Error()})
}

func stripBearer(h string) string {
	if strings.HasPrefix(h, "Bearer ") {
		return h[len("Bearer "):]
	}
	return h
}
