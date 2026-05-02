package api

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"meo.md/backend/internal/auth"
	"meo.md/backend/internal/store"
)

// Server is the composition root for the HTTP layer. All deps are
// fields injected via NewServer — no package globals, no init().
//
// Each handler method takes (c *gin.Context) and uses s.<dep> to do
// its work, so a test can construct a Server with fake stores +
// fake hasher + fake signer and exercise the handlers in isolation.
type Server struct {
	users    *store.UserStore
	accounts *store.AccountStore
	notes    *store.NoteStore
	sync     *store.SyncCursorStore
	hasher   *auth.Hasher
	signer   *auth.JWTSigner
}

// NewServer wires the dependencies. Caller (cmd/server/main.go) is
// the one place that knows how to build each piece.
func NewServer(
	users *store.UserStore,
	accounts *store.AccountStore,
	notes *store.NoteStore,
	sync *store.SyncCursorStore,
	hasher *auth.Hasher,
	signer *auth.JWTSigner,
) *Server {
	return &Server{
		users: users, accounts: accounts, notes: notes, sync: sync,
		hasher: hasher, signer: signer,
	}
}

// Routes returns a *gin.Engine with every route registered. Kept as
// a method so callers can wrap the engine (e.g. add metrics
// middleware) without forking this package.
func (s *Server) Routes() *gin.Engine {
	gin.SetMode(gin.ReleaseMode) // suppress the "running in debug mode" banner
	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(corsMiddleware())

	r.GET("/healthz", s.healthz)

	r.POST("/auth/signup", s.signup)
	r.POST("/auth/login", s.login)

	auth := r.Group("")
	auth.Use(s.requireAuth)
	{
		auth.GET("/account", s.getAccount)
		auth.PUT("/account", s.putAccount)
		auth.GET("/sync/notes", s.syncNotes)
		auth.POST("/notes", s.upsertNote)
		auth.DELETE("/notes/:id", s.deleteNote)
	}

	return r
}

// corsMiddleware mirrors the TS server's `cors({ origin: '*', ... })`.
// Gin doesn't ship a CORS middleware in the core package; rolling our
// own keeps the dep tree thin.
func corsMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Writer.Header().Set("Access-Control-Allow-Origin", "*")
		c.Writer.Header().Set("Access-Control-Allow-Headers", "authorization, content-type")
		c.Writer.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

// healthz is the liveness probe. Identical body to the TS server so
// no client has to change its expectation.
func (s *Server) healthz(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"ok":      true,
		"service": "meo.md backend",
		"ts":      time.Now().UnixMilli(),
	})
}
