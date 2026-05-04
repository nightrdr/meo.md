package api

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// claimsKey is the gin.Context key under which we stash the verified
// JWT claims so handlers downstream don't have to re-parse.
const claimsKey = "meo.claims"

// requireAuth verifies the Bearer token using the Supabase JWT secret.
// On success, the parsed Claims are stashed into the context. On any
// failure the request short-circuits with 401 so the handler never
// runs and never trusts an unverified user_id.
func (s *Server) requireAuth(c *gin.Context) {
	header := c.GetHeader("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	claims, err := s.jwt.Verify(strings.TrimPrefix(header, "Bearer "))
	if err != nil {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid token", "detail": err.Error()})
		return
	}
	c.Set(claimsKey, claims)
	c.Next()
}
