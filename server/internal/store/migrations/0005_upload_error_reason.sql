-- 记录上传失败的稳定原因（invalid_file 白名单等），供日志、GET /uploads
-- 与前端诊断使用；非校验类失败写 NULL，旧行保持 NULL。
ALTER TABLE upload_intents ADD COLUMN error_reason TEXT NULL;
