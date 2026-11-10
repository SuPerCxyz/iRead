package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// AdminRecord 是单管理员凭据记录。
type AdminRecord struct {
	PasswordHash      string
	PasswordChangedAt time.Time
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

// SessionRecord 是服务端会话记录；ID 为原始 Cookie 令牌的 SHA-256 hex。
type SessionRecord struct {
	ID                string
	UserID            string
	CSRFHash          string
	CSRFExpiresAt     time.Time
	CreatedAt         time.Time
	LastSeenAt        time.Time
	IdleExpiresAt     time.Time
	AbsoluteExpiresAt time.Time
	RevokedAt         *time.Time
	UserAgent         string
}

// AuthContextRecord 是预认证 CSRF 上下文；ID 为原始 Cookie 令牌的 SHA-256 hex。
type AuthContextRecord struct {
	ID        string
	CSRFHash  string
	CreatedAt time.Time
	ExpiresAt time.Time
	UsedAt    *time.Time
}

// GetAdmin 返回单管理员凭据；未初始化时 found=false。
func (s *Store) GetAdmin(ctx context.Context) (AdminRecord, bool, error) {
	var record AdminRecord
	var changed, created, updated string
	err := s.db.QueryRowContext(ctx, `
		SELECT password_hash, password_changed_at, created_at, updated_at
		FROM users WHERE id = ?`, "admin").
		Scan(&record.PasswordHash, &changed, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return AdminRecord{}, false, nil
	}
	if err != nil {
		return AdminRecord{}, false, fmt.Errorf("读取管理员凭据失败: %w", err)
	}
	if record.PasswordChangedAt, err = parseAuthTime("password_changed_at", changed); err != nil {
		return AdminRecord{}, false, err
	}
	if record.CreatedAt, err = parseAuthTime("created_at", created); err != nil {
		return AdminRecord{}, false, err
	}
	if record.UpdatedAt, err = parseAuthTime("updated_at", updated); err != nil {
		return AdminRecord{}, false, err
	}
	return record, true, nil
}

// AdminExists 判断唯一管理员是否已初始化。
func (s *Store) AdminExists(ctx context.Context) (bool, error) {
	var one int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM users WHERE id = ?`, "admin").Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("检查管理员初始化状态失败: %w", err)
	}
	return true, nil
}

// CreateAdminSession 原子地创建管理员、会话并删除预认证上下文。
// 返回 false 表示其他并发 setup 已完成初始化；此时不写任何行。
func (s *Store) CreateAdminSession(ctx context.Context, passwordHash string, now time.Time, session SessionRecord, preAuthID string) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("开始初始化事务失败: %w", err)
	}
	defer func() { _ = rollbackAuthTx(tx) }()

	created := formatAuthTime(now)
	result, err := tx.ExecContext(ctx, `
		INSERT INTO users (id, password_hash, password_scheme, password_changed_at, created_at, updated_at)
		VALUES ('admin', ?, 'argon2id', ?, ?, ?)
		ON CONFLICT(id) DO NOTHING`,
		passwordHash, created, created, created)
	if err != nil {
		return false, fmt.Errorf("创建管理员失败: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("读取管理员创建结果失败: %w", err)
	}
	if affected == 0 {
		return false, nil
	}
	if err := insertSession(ctx, tx, session); err != nil {
		return false, err
	}
	if preAuthID != "" {
		if _, err := tx.ExecContext(ctx, `DELETE FROM auth_contexts WHERE id = ?`, preAuthID); err != nil {
			return false, fmt.Errorf("删除预认证上下文失败: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("提交初始化事务失败: %w", err)
	}
	return true, nil
}

// CreateSession 创建新会话；可同时撤销旧会话并删除预认证上下文。
func (s *Store) CreateSession(ctx context.Context, session SessionRecord, revokeSessionID, preAuthID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("开始会话事务失败: %w", err)
	}
	defer func() { _ = rollbackAuthTx(tx) }()

	if revokeSessionID != "" {
		if _, err := tx.ExecContext(ctx, `
			UPDATE sessions SET revoked_at = ?
			WHERE id = ? AND revoked_at IS NULL`,
			formatAuthTime(session.CreatedAt), revokeSessionID); err != nil {
			return fmt.Errorf("撤销旧会话失败: %w", err)
		}
	}
	if err := insertSession(ctx, tx, session); err != nil {
		return err
	}
	if preAuthID != "" {
		if _, err := tx.ExecContext(ctx, `DELETE FROM auth_contexts WHERE id = ?`, preAuthID); err != nil {
			return fmt.Errorf("删除预认证上下文失败: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("提交会话事务失败: %w", err)
	}
	return nil
}

func insertSession(ctx context.Context, tx *sql.Tx, session SessionRecord) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO sessions (
			id, user_id, csrf_hash, csrf_expires_at, created_at, last_seen_at,
			idle_expires_at, absolute_expires_at, revoked_at, user_agent
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
		session.ID,
		session.UserID,
		session.CSRFHash,
		formatAuthTime(session.CSRFExpiresAt),
		formatAuthTime(session.CreatedAt),
		formatAuthTime(session.LastSeenAt),
		formatAuthTime(session.IdleExpiresAt),
		formatAuthTime(session.AbsoluteExpiresAt),
		session.UserAgent,
	)
	if err != nil {
		return fmt.Errorf("创建会话失败: %w", err)
	}
	return nil
}

// GetSession 按 Cookie 令牌 hash 读取会话，包括已撤销会话，由调用方判定状态。
func (s *Store) GetSession(ctx context.Context, id string) (SessionRecord, bool, error) {
	var record SessionRecord
	var csrfExpires, created, lastSeen, idleExpires, absoluteExpires, revoked string
	var revokedNull sql.NullString
	var userAgent string
	err := s.db.QueryRowContext(ctx, `
		SELECT id, user_id, csrf_hash, csrf_expires_at, created_at, last_seen_at,
		       idle_expires_at, absolute_expires_at, revoked_at, user_agent
		FROM sessions WHERE id = ?`, id).
		Scan(&record.ID, &record.UserID, &record.CSRFHash, &csrfExpires,
			&created, &lastSeen, &idleExpires, &absoluteExpires, &revokedNull, &userAgent)
	if errors.Is(err, sql.ErrNoRows) {
		return SessionRecord{}, false, nil
	}
	if err != nil {
		return SessionRecord{}, false, fmt.Errorf("读取会话失败: %w", err)
	}
	revoked = revokedNull.String
	if record.CSRFExpiresAt, err = parseAuthTime("csrf_expires_at", csrfExpires); err != nil {
		return SessionRecord{}, false, err
	}
	if record.CreatedAt, err = parseAuthTime("created_at", created); err != nil {
		return SessionRecord{}, false, err
	}
	if record.LastSeenAt, err = parseAuthTime("last_seen_at", lastSeen); err != nil {
		return SessionRecord{}, false, err
	}
	if record.IdleExpiresAt, err = parseAuthTime("idle_expires_at", idleExpires); err != nil {
		return SessionRecord{}, false, err
	}
	if record.AbsoluteExpiresAt, err = parseAuthTime("absolute_expires_at", absoluteExpires); err != nil {
		return SessionRecord{}, false, err
	}
	if revokedNull.Valid {
		parsed, err := parseAuthTime("revoked_at", revoked)
		if err != nil {
			return SessionRecord{}, false, err
		}
		record.RevokedAt = &parsed
	}
	record.UserAgent = userAgent
	return record, true, nil
}

// TouchSession 更新最后活动时间与空闲到期时间。
func (s *Store) TouchSession(ctx context.Context, id string, lastSeen, idleExpiresAt time.Time) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE sessions SET last_seen_at = ?, idle_expires_at = ?
		WHERE id = ? AND revoked_at IS NULL`,
		formatAuthTime(lastSeen), formatAuthTime(idleExpiresAt), id)
	if err != nil {
		return fmt.Errorf("更新会话活动时间失败: %w", err)
	}
	return nil
}

// RotateSessionCSRF 轮换会话 CSRF hash 与到期时间。
func (s *Store) RotateSessionCSRF(ctx context.Context, id, csrfHash string, expiresAt time.Time) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE sessions SET csrf_hash = ?, csrf_expires_at = ?
		WHERE id = ? AND revoked_at IS NULL`,
		csrfHash, formatAuthTime(expiresAt), id)
	if err != nil {
		return fmt.Errorf("轮换会话 CSRF 失败: %w", err)
	}
	return nil
}

// RevokeSession 幂等地撤销会话。
func (s *Store) RevokeSession(ctx context.Context, id string, now time.Time) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE sessions SET revoked_at = ?
		WHERE id = ? AND revoked_at IS NULL`, formatAuthTime(now), id)
	if err != nil {
		return fmt.Errorf("撤销会话失败: %w", err)
	}
	return nil
}

// CreateAuthContext 创建预认证上下文。
func (s *Store) CreateAuthContext(ctx context.Context, record AuthContextRecord) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO auth_contexts (id, csrf_hash, created_at, expires_at, used_at)
		VALUES (?, ?, ?, ?, NULL)`,
		record.ID, record.CSRFHash, formatAuthTime(record.CreatedAt), formatAuthTime(record.ExpiresAt))
	if err != nil {
		return fmt.Errorf("创建预认证上下文失败: %w", err)
	}
	return nil
}

// GetAuthContext 读取预认证上下文；过期/已用由调用方判定。
func (s *Store) GetAuthContext(ctx context.Context, id string) (AuthContextRecord, bool, error) {
	var record AuthContextRecord
	var created, expires string
	var used sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT id, csrf_hash, created_at, expires_at, used_at
		FROM auth_contexts WHERE id = ?`, id).
		Scan(&record.ID, &record.CSRFHash, &created, &expires, &used)
	if errors.Is(err, sql.ErrNoRows) {
		return AuthContextRecord{}, false, nil
	}
	if err != nil {
		return AuthContextRecord{}, false, fmt.Errorf("读取预认证上下文失败: %w", err)
	}
	var parseErr error
	if record.CreatedAt, parseErr = parseAuthTime("created_at", created); parseErr != nil {
		return AuthContextRecord{}, false, parseErr
	}
	if record.ExpiresAt, parseErr = parseAuthTime("expires_at", expires); parseErr != nil {
		return AuthContextRecord{}, false, parseErr
	}
	if used.Valid {
		parsed, err := parseAuthTime("used_at", used.String)
		if err != nil {
			return AuthContextRecord{}, false, err
		}
		record.UsedAt = &parsed
	}
	return record, true, nil
}

// RotateAuthContextCSRF 轮换预认证 CSRF hash。
func (s *Store) RotateAuthContextCSRF(ctx context.Context, id, csrfHash string, expiresAt time.Time) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE auth_contexts SET csrf_hash = ?, expires_at = ?
		WHERE id = ? AND used_at IS NULL`,
		csrfHash, formatAuthTime(expiresAt), id)
	if err != nil {
		return fmt.Errorf("轮换预认证 CSRF 失败: %w", err)
	}
	return nil
}

// DeleteAuthContext 删除预认证上下文。
func (s *Store) DeleteAuthContext(ctx context.Context, id string) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM auth_contexts WHERE id = ?`, id); err != nil {
		return fmt.Errorf("删除预认证上下文失败: %w", err)
	}
	return nil
}

// DeleteExpiredAuthContexts 清理已过期的预认证上下文。
func (s *Store) DeleteExpiredAuthContexts(ctx context.Context, now time.Time) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM auth_contexts WHERE expires_at <= ?`, formatAuthTime(now)); err != nil {
		return fmt.Errorf("清理预认证上下文失败: %w", err)
	}
	return nil
}

func formatAuthTime(t time.Time) string {
	// 固定 9 位小数，保证文本比较与时间顺序一致；仍是 RFC3339Nano。
	return t.UTC().Format("2006-01-02T15:04:05.000000000Z")
}

func parseAuthTime(field, value string) (time.Time, error) {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("数据库时间字段 %s 无效: %w", field, err)
	}
	return parsed.UTC(), nil
}

func rollbackAuthTx(tx *sql.Tx) error {
	err := tx.Rollback()
	if err == nil || errors.Is(err, sql.ErrTxDone) {
		return nil
	}
	return err
}
