// Package auth implements argon2id password hashing and cookie-based
// authentication for the single-user pi-webui server.
package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/argon2"
)

const (
	argonTime    = 1
	argonMemory  = 64 * 1024
	argonThreads = 4
	argonKeyLen  = 32
	argonSaltLen = 16
)

// PasswordChars is the alphabet used for generated passwords. It avoids
// visually ambiguous characters (0/O, 1/l/I, etc.).
const PasswordChars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"

// RandomPassword returns a cryptographically random password of length n.
func RandomPassword(n int) string {
	if n <= 0 {
		n = 16
	}
	b := make([]byte, n)
	charsLen := byte(len(PasswordChars))
	for i := 0; i < n; {
		var rnd [1]byte
		if _, err := rand.Read(rnd[:]); err != nil {
			panic(fmt.Sprintf("auth: crypto/rand unavailable: %v", err))
		}
		// Reject values that would bias modulo.
		if int(rnd[0]) >= int(charsLen)*(256/int(charsLen)) {
			continue
		}
		b[i] = PasswordChars[int(rnd[0])%int(charsLen)]
		i++
	}
	return string(b)
}

// HashPassword returns an encoded argon2id hash string:
//
//	$argon2id$v=19$m=65536,t=1,p=4$<salt>$<key>
func HashPassword(password string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("auth: generate salt: %w", err)
	}
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf(
		"$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version,
		argonMemory,
		argonTime,
		argonThreads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	), nil
}

// VerifyPassword reports whether password matches the encoded argon2id hash.
func VerifyPassword(password, encoded string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false
	}
	var version, memory, timeCost, threads uint32
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil {
		return false
	}
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &timeCost, &threads); err != nil {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false
	}
	if memory == 0 || timeCost == 0 || threads == 0 || len(salt) == 0 || len(want) == 0 {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, timeCost, memory, uint8(threads), uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}

// CookieConfig mirrors config.Auth.Cookie.
type CookieConfig struct {
	Name          string
	HttpOnly      bool
	SameSite      string // lax|strict|none
	Secure        string // auto|true|false
	MaxAgeSeconds int
	Sliding       bool
}

// CookieManager issues and validates HMAC-signed session cookies. The signing
// key is derived from the configured password hash so cookies survive restarts
// but are invalidated when the password changes.
type CookieManager struct {
	Cfg    CookieConfig
	secret []byte
}

// NewCookieManager derives a stable signing key from the password hash.
func NewCookieManager(passwordHash string, cfg CookieConfig) *CookieManager {
	sum := sha256.Sum256([]byte("pi-webui-cookie:" + passwordHash))
	return &CookieManager{Cfg: cfg, secret: sum[:]}
}

func (m *CookieManager) name() string {
	if m.Cfg.Name == "" {
		return "pi_webui_session"
	}
	return m.Cfg.Name
}

func (m *CookieManager) maxAge() int {
	if m.Cfg.MaxAgeSeconds <= 0 {
		return 86400
	}
	return m.Cfg.MaxAgeSeconds
}

func (m *CookieManager) secure(r *http.Request) bool {
	switch strings.ToLower(m.Cfg.Secure) {
	case "true":
		return true
	case "false":
		return false
	default: // auto
		return strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
	}
}

func (m *CookieManager) sameSite() http.SameSite {
	switch strings.ToLower(m.Cfg.SameSite) {
	case "strict":
		return http.SameSiteStrictMode
	case "none":
		return http.SameSiteNoneMode
	default:
		return http.SameSiteLaxMode
	}
}

func (m *CookieManager) sign(expiry int64) string {
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], uint64(expiry))
	mac := hmac.New(sha256.New, m.secret)
	mac.Write(buf[:])
	return base64.RawURLEncoding.EncodeToString(buf[:]) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (m *CookieManager) verify(token string) (int64, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return 0, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || len(payload) != 8 {
		return 0, false
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return 0, false
	}
	mac := hmac.New(sha256.New, m.secret)
	mac.Write(payload)
	want := mac.Sum(nil)
	if !hmac.Equal(sig, want) {
		return 0, false
	}
	expiry := int64(binary.BigEndian.Uint64(payload))
	if time.Now().Unix() > expiry {
		return 0, false
	}
	return expiry, true
}

// SetAuthCookie issues (or slides) the session cookie.
func (m *CookieManager) SetAuthCookie(w http.ResponseWriter, r *http.Request) {
	expiry := time.Now().Add(time.Duration(m.maxAge()) * time.Second).Unix()
	token := m.sign(expiry)
	http.SetCookie(w, &http.Cookie{
		Name:     m.name(),
		Value:    token,
		Path:     "/",
		MaxAge:   m.maxAge(),
		HttpOnly: m.Cfg.HttpOnly,
		SameSite: m.sameSite(),
		Secure:   m.secure(r),
	})
}

// ClearAuthCookie clears the session cookie.
func (m *CookieManager) ClearAuthCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     m.name(),
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: m.Cfg.HttpOnly,
		SameSite: m.sameSite(),
	})
}

// Authenticate validates the request cookie. When sliding is enabled, a
// validated request gets a fresh cookie.
func (m *CookieManager) Authenticate(w http.ResponseWriter, r *http.Request) bool {
	cookie, err := r.Cookie(m.name())
	if err != nil {
		return false
	}
	if _, ok := m.verify(cookie.Value); !ok {
		return false
	}
	if m.Cfg.Sliding {
		m.SetAuthCookie(w, r)
	}
	return true
}

// AuthMiddleware wraps a handler and rejects unauthenticated API requests.
func (m *CookieManager) AuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !m.Authenticate(w, r) {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ErrInvalidSessionFile is returned when a file does not look like a pi session.
var ErrInvalidSessionFile = errors.New("invalid pi session file")
