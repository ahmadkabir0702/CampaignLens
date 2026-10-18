-- =====================================================================
--  015 — last_login, and letting people change their own password
--
--  Two gaps that only became expensive once the logins went out.
--
--  LAST LOGIN. Nothing recorded when an account was last used, so the
--  only way to tell whether a login was still in use was to ask the
--  person it belonged to. Eight accounts sat in app_users in October
--  that nobody could account for, and the answer had to come from the
--  client by email.
--
--  PASSWORD CHANGES. There was no way to change a password except by
--  editing the hash by hand. With 24 shared logins across a client and
--  eight agencies, that means every departure, every suspected leak and
--  every routine rotation is a database job. It also means the password
--  somebody was given on day one is the password they still have.
--
--  must_change_password is here for the rotation after this ships: set
--  it on an account and the next sign-in has to pick a new password
--  before anything else happens.
-- =====================================================================

alter table app_users
  add column if not exists last_login_at        timestamptz,
  add column if not exists password_changed_at  timestamptz,
  add column if not exists must_change_password boolean not null default false;

-- Existing accounts have a password set at creation and never changed, so
-- the creation time is the honest answer for when it was last set.
update app_users
   set password_changed_at = created_at
 where password_changed_at is null;

comment on column app_users.last_login_at is
  'Set on every successful sign-in. The only way to tell a live account from an abandoned one.';
comment on column app_users.must_change_password is
  'Forces a password change on next sign-in. Set this when rotating a shared login.';
