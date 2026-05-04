// Package api defines HTTP handlers and the wire DTOs they exchange.
package api

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"meo.md/backend/internal/auth"
	"meo.md/backend/internal/models"
	"meo.md/backend/internal/store"
)

// Server is the composition root for the HTTP layer. Each handler
// method takes (c *gin.Context) and reads its dependencies off the
// struct, so a test can construct a Server with fake stores + fake
// GoTrue and exercise handlers in isolation.
type Server struct {
	store         *store.Store
	gotrue        *auth.GoTrueClient
	jwt           *auth.JWTVerifier
	attachmentDir string

	models     *models.Catalogue // nil if model service is disabled
	modelStore *models.Store     // nil if model service is disabled
	adminToken string            // empty disables admin model uploads
}

// NewServer wires the dependencies. cmd/server/main.go is the one
// place that knows how to build each piece.
func NewServer(
	st *store.Store,
	gt *auth.GoTrueClient,
	jv *auth.JWTVerifier,
	attachmentDir string,
) *Server {
	return &Server{
		store: st, gotrue: gt, jwt: jv, attachmentDir: attachmentDir,
	}
}

// WithModels attaches the model-download subsystem. Pass nil for the
// store if the directory couldn't be created — the routes will return
// 503 instead of 500.
func (s *Server) WithModels(catalogue *models.Catalogue, mstore *models.Store, adminToken string) *Server {
	s.models = catalogue
	s.modelStore = mstore
	s.adminToken = adminToken
	return s
}

// Routes returns a *gin.Engine with every route registered. Kept as
// a method so callers can wrap the engine (e.g. add metrics
// middleware) without forking this package.
func (s *Server) Routes() *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(corsMiddleware())

	r.GET("/healthz", s.healthz)

	// Auth — public.
	r.POST("/auth/otp/request", s.requestOTP)
	r.POST("/auth/otp/verify", s.verifyOTP)
	r.POST("/auth/refresh", s.refresh)
	r.POST("/auth/signup", s.passwordSignup) // legacy
	r.POST("/auth/login", s.passwordLogin)   // legacy

	// Model download service — public reads, admin-token-gated upload.
	r.GET("/models/manifest", s.listModelManifest)
	r.GET("/models/:id/file", s.streamModelFile)
	r.POST("/models/:id/upload", s.uploadModelFile)

	// Handovers — anonymous, the id IS the secret.
	r.POST("/handovers", s.handoverCreate)
	r.GET("/handovers/:id", s.handoverGet)
	r.PUT("/handovers/:id/b", s.handoverPutB)
	r.PUT("/handovers/:id/payload", s.handoverPutPayload)
	r.DELETE("/handovers/:id", s.handoverClear)

	// Authed routes.
	authed := r.Group("")
	authed.Use(s.requireAuth)
	{
		authed.POST("/auth/logout", s.logout)

		authed.GET("/account", s.getAccount)
		authed.PUT("/account", s.putAccount)

		authed.GET("/sync/notes", s.syncNotes)
		authed.POST("/notes", s.upsertNote)
		authed.DELETE("/notes/:id", s.deleteNote)

		authed.GET("/devices", s.listDevices)
		authed.POST("/devices", s.registerDevice)
		authed.DELETE("/devices/:device_id", s.revokeDevice)

		authed.GET("/subscription", s.getSubscription)
		authed.GET("/storage/usage", s.getStorageUsage)

		authed.POST("/attachments", s.createAttachment)
		authed.GET("/notes/:note_id/attachments", s.listAttachmentsByNote)
		authed.GET("/attachments/:id/file", s.streamAttachment)
		authed.DELETE("/attachments/:id", s.deleteAttachment)

		authed.GET("/tfa/status", s.tfaStatus)
		authed.POST("/tfa/enroll", s.tfaEnroll)
		authed.GET("/tfa/secret", s.tfaGetSecret)
		authed.POST("/tfa/disable", s.tfaDisable)
		authed.DELETE("/tfa", s.tfaDelete)
	}

	return r
}

// corsMiddleware mirrors `cors({ origin: '*', ... })` from the
// previous TS server — trivial on a backend with no cross-origin
// browser usage in prod, but useful for local Vite dev.
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

// healthz is the liveness probe.
func (s *Server) healthz(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"ok":      true,
		"service": "meo.md backend",
		"ts":      time.Now().UnixMilli(),
	})
}
