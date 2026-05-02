package api

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// claimsKey is the gin.Context key under which we stash the verified
// JWT claims so handlers downstream don't have to re-parse.
const claimsKey = "meo.claims"

// requireAuth verifies the Bearer token. On success, the parsed
// Claims are stashed into the context (handlers fetch them via
// c.MustGet(claimsKey).(*auth.Claims)). On any failure, the request
// short-circuits with 401 so the handler never runs.
func (s *Server) requireAuth(c *gin.Context) {
	header := c.GetHeader("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	claims, err := s.signer.Verify(strings.TrimPrefix(header, "Bearer "))
	if err != nil {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid token"})
		return
	}
	c.Set(claimsKey, claims)
	c.Next()
}
