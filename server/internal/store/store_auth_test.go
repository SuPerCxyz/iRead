package store

import (
	"context"
	"testing"
	"time"

	"iread/server/internal/auth"
)

func TestCreateAdminSessionAtomically(t *testing.T) {
	database := openTestStore(t, t.TempDir())
	ctx := context.Background()
	now := time.Date(2026, 11, 10, 12, 0, 0, 123456789, time.UTC)

	_, preAuthID, err := auth.NewToken()
	if err != nil {
		t.Fatal(err)
	}
	if err := database.CreateAuthContext(ctx, AuthContextRecord{
		ID:        preAuthID,
		CSRFHash:  auth.HashToken("preauth-csrf"),
		CreatedAt: now,
		ExpiresAt: now.Add(15 * time.Minute),
	}); err != nil {
		t.Fatal(err)
	}

	sessionRaw, sessionID, err := auth.NewToken()
	if err != nil {
		t.Fatal(err)
	}
	session := SessionRecord{
		ID:                sessionID,
		UserID:            "admin",
		CSRFHash:          auth.HashToken("session-csrf"),
		CSRFExpiresAt:     now.Add(30 * time.Minute),
		CreatedAt:         now,
		LastSeenAt:        now,
		IdleExpiresAt:     now.Add(7 * 24 * time.Hour),
		AbsoluteExpiresAt: now.Add(30 * 24 * time.Hour),
		UserAgent:         "test-agent",
	}
	created, err := database.CreateAdminSession(ctx, "$argon2id$test-hash", now, session, preAuthID)
	if err != nil {
		t.Fatal(err)
	}
	if !created {
		t.Fatal("首次 CreateAdminSession 应成功")
	}

	admin, found, err := database.GetAdmin(ctx)
	if err != nil || !found {
		t.Fatalf("GetAdmin = %+v, %v, %v", admin, found, err)
	}
	if admin.PasswordHash != "$argon2id$test-hash" || admin.PasswordChangedAt != now {
		t.Fatalf("管理员记录 = %+v", admin)
	}
	exists, err := database.AdminExists(ctx)
	if err != nil || !exists {
		t.Fatalf("AdminExists = %v, %v", exists, err)
	}

	storedSession, found, err := database.GetSession(ctx, sessionID)
	if err != nil || !found {
		t.Fatalf("GetSession = %+v, %v, %v", storedSession, found, err)
	}
	if storedSession.ID == sessionRaw || storedSession.CSRFHash == "session-csrf" ||
		storedSession.UserAgent != "test-agent" || storedSession.RevokedAt != nil {
		t.Fatalf("会话记录 = %+v", storedSession)
	}

	if _, found, err := database.GetAuthContext(ctx, preAuthID); err != nil {
		t.Fatal(err)
	} else if found {
		t.Fatal("创建管理员后应删除预认证上下文")
	}

	_, secondID, err := auth.NewToken()
	if err != nil {
		t.Fatal(err)
	}
	second := session
	second.ID = secondID
	created, err = database.CreateAdminSession(ctx, "$argon2id$other", now, second, "")
	if err != nil {
		t.Fatal(err)
	}
	if created {
		t.Fatal("重复 CreateAdminSession 不应成功")
	}
	if _, found, err := database.GetSession(ctx, secondID); err != nil {
		t.Fatal(err)
	} else if found {
		t.Fatal("失败的 setup 不应写入第二个会话")
	}
}

func TestSessionLifecycle(t *testing.T) {
	database := openTestStore(t, t.TempDir())
	ctx := context.Background()
	now := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)

	_, initialID, err := auth.NewToken()
	if err != nil {
		t.Fatal(err)
	}
	initial := SessionRecord{
		ID:                initialID,
		UserID:            "admin",
		CSRFHash:          auth.HashToken("initial-csrf"),
		CSRFExpiresAt:     now.Add(30 * time.Minute),
		CreatedAt:         now,
		LastSeenAt:        now,
		IdleExpiresAt:     now.Add(7 * 24 * time.Hour),
		AbsoluteExpiresAt: now.Add(30 * 24 * time.Hour),
	}
	if created, err := database.CreateAdminSession(ctx, "$argon2id$test", now, initial, ""); err != nil || !created {
		t.Fatalf("创建管理员失败: created=%v err=%v", created, err)
	}

	raw, id, err := auth.NewToken()
	if err != nil {
		t.Fatal(err)
	}
	session := SessionRecord{
		ID:                id,
		UserID:            "admin",
		CSRFHash:          auth.HashToken("csrf-one"),
		CSRFExpiresAt:     now.Add(30 * time.Minute),
		CreatedAt:         now.Add(time.Second),
		LastSeenAt:        now.Add(time.Second),
		IdleExpiresAt:     now.Add(7 * 24 * time.Hour),
		AbsoluteExpiresAt: now.Add(30 * 24 * time.Hour),
	}
	if err := database.CreateSession(ctx, session, initialID, ""); err != nil {
		t.Fatalf("CreateSession 失败: %v", err)
	}
	if raw == id {
		t.Fatal("会话 ID 不应等于原始令牌")
	}

	old, found, err := database.GetSession(ctx, initialID)
	if err != nil || !found || old.RevokedAt == nil {
		t.Fatalf("旧会话应被撤销: %+v, %v, %v", old, found, err)
	}

	stored, found, err := database.GetSession(ctx, id)
	if err != nil || !found {
		t.Fatalf("GetSession = %+v, %v, %v", stored, found, err)
	}
	if stored.CSRFHash != auth.HashToken("csrf-one") || stored.RevokedAt != nil {
		t.Fatalf("会话记录 = %+v", stored)
	}

	touched := now.Add(2 * time.Minute)
	if err := database.TouchSession(ctx, id, touched, touched.Add(7*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	csrfRaw, csrfHash, err := auth.NewToken()
	if err != nil {
		t.Fatal(err)
	}
	csrfExpires := touched.Add(30 * time.Minute)
	if err := database.RotateSessionCSRF(ctx, id, csrfHash, csrfExpires); err != nil {
		t.Fatal(err)
	}
	stored, found, err = database.GetSession(ctx, id)
	if err != nil || !found {
		t.Fatalf("轮换后 GetSession = %+v, %v, %v", stored, found, err)
	}
	if !stored.LastSeenAt.Equal(touched) || !stored.CSRFExpiresAt.Equal(csrfExpires) ||
		stored.CSRFHash != auth.HashToken(csrfRaw) {
		t.Fatalf("会话未更新: %+v", stored)
	}

	if err := database.RevokeSession(ctx, id, touched.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	stored, found, err = database.GetSession(ctx, id)
	if err != nil || !found || stored.RevokedAt == nil {
		t.Fatalf("撤销后 GetSession = %+v, %v, %v", stored, found, err)
	}
}

func TestAuthContextLifecycle(t *testing.T) {
	database := openTestStore(t, t.TempDir())
	ctx := context.Background()
	now := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)

	raw, id, err := auth.NewToken()
	if err != nil {
		t.Fatal(err)
	}
	if err := database.CreateAuthContext(ctx, AuthContextRecord{
		ID:        id,
		CSRFHash:  auth.HashToken("csrf-one"),
		CreatedAt: now,
		ExpiresAt: now.Add(15 * time.Minute),
	}); err != nil {
		t.Fatal(err)
	}
	stored, found, err := database.GetAuthContext(ctx, id)
	if err != nil || !found {
		t.Fatalf("GetAuthContext = %+v, %v, %v", stored, found, err)
	}
	if stored.ID == raw || stored.CSRFHash != auth.HashToken("csrf-one") || stored.UsedAt != nil {
		t.Fatalf("预认证记录 = %+v", stored)
	}

	csrfRaw, csrfHash, err := auth.NewToken()
	if err != nil {
		t.Fatal(err)
	}
	rotatedExpires := now.Add(15 * time.Minute)
	if err := database.RotateAuthContextCSRF(ctx, id, csrfHash, rotatedExpires); err != nil {
		t.Fatal(err)
	}
	stored, found, err = database.GetAuthContext(ctx, id)
	if err != nil || !found || stored.CSRFHash != auth.HashToken(csrfRaw) || !stored.ExpiresAt.Equal(rotatedExpires) {
		t.Fatalf("轮换后预认证记录 = %+v, %v, %v", stored, found, err)
	}

	if err := database.DeleteExpiredAuthContexts(ctx, now); err != nil {
		t.Fatal(err)
	}
	if _, found, err := database.GetAuthContext(ctx, id); err != nil {
		t.Fatal(err)
	} else if !found {
		t.Fatal("未过期上下文不应被清理")
	}
	if err := database.DeleteExpiredAuthContexts(ctx, now.Add(16*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, found, err := database.GetAuthContext(ctx, id); err != nil {
		t.Fatal(err)
	} else if found {
		t.Fatal("过期上下文应被清理")
	}

	_, secondID, err := auth.NewToken()
	if err != nil {
		t.Fatal(err)
	}
	if err := database.CreateAuthContext(ctx, AuthContextRecord{
		ID:        secondID,
		CSRFHash:  auth.HashToken("csrf-two"),
		CreatedAt: now,
		ExpiresAt: now.Add(15 * time.Minute),
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.DeleteAuthContext(ctx, secondID); err != nil {
		t.Fatal(err)
	}
	if _, found, err := database.GetAuthContext(ctx, secondID); err != nil {
		t.Fatal(err)
	} else if found {
		t.Fatal("DeleteAuthContext 未删除记录")
	}
}
