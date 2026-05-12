import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getUserByIdFromDb, softDeleteUserInDb, updateUserInDb } from '$lib/server/db';
import { generateSecurePassword, hashPassword } from '$lib/server/security';
import { deleteEmailRoutingRulesForUser, ensureEmailRoutingRuleForUser } from '$lib/server/cloudflare-email-routing';

export const GET: RequestHandler = async ({ platform, params, locals }) => {
  if (locals.sessionRole !== 'owner') {
    return json({ error: 'Akses ditolak' }, { status: 403 });
  }

  const user = await getUserByIdFromDb(platform?.env?.DB, params.userId);
  if (!user) {
    return json({ error: 'Pengguna tidak ditemukan' }, { status: 404 });
  }

  return json({ user });
};

export const PATCH: RequestHandler = async ({ platform, params, request, locals }) => {
  if (locals.sessionRole !== 'owner') {
    return json({ error: 'Akses ditolak' }, { status: 403 });
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return json({ error: 'Isi JSON wajib dikirim' }, { status: 400 });
  }

  const body = (await request.json()) as { email?: string; displayName?: string; password?: string; resetPassword?: boolean };
  const resetPassword = body.resetPassword === true;
  const email = body.email?.trim().toLowerCase();
  const displayName = body.displayName?.trim();
  const password = body.password;

  if (resetPassword) {
    try {
      const generatedPassword = generateSecurePassword(18);
      const passwordHash = await hashPassword(generatedPassword);
      const user = await updateUserInDb(platform?.env?.DB, params.userId, { passwordHash });
      if (!user) {
        return json({ error: 'Pengguna tidak ditemukan' }, { status: 404 });
      }

      return json({ ok: true, user, password: generatedPassword });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('DB binding is required')) {
        return json({ error: 'Database belum dikonfigurasi' }, { status: 503 });
      }

      return json({ error: 'Gagal reset kata sandi' }, { status: 500 });
    }
  }

  if (email === undefined && displayName === undefined && password === undefined) {
    return json({ error: 'Tidak ada kolom untuk diperbarui' }, { status: 400 });
  }
  if (email !== undefined && !email) {
    return json({ error: 'Email tidak boleh kosong' }, { status: 400 });
  }
  if (displayName !== undefined && !displayName) {
    return json({ error: 'Nama tampilan tidak boleh kosong' }, { status: 400 });
  }
  if (email && email.length > 254) {
    return json({ error: 'Email terlalu panjang' }, { status: 400 });
  }
  if (displayName && displayName.length > 120) {
    return json({ error: 'Nama tampilan terlalu panjang' }, { status: 400 });
  }
  if (password !== undefined && (password.length < 8 || password.length > 128)) {
    return json({ error: 'Kata sandi harus 8-128 karakter' }, { status: 400 });
  }

  if (email) {
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(email)) {
      return json({ error: 'Format email tidak valid' }, { status: 400 });
    }
  }

  try {
    const existingUser = await getUserByIdFromDb(platform?.env?.DB, params.userId);
    if (!existingUser) {
      return json({ error: 'Pengguna tidak ditemukan' }, { status: 404 });
    }

    const passwordHash = password ? await hashPassword(password) : undefined;
    const user = await updateUserInDb(platform?.env?.DB, params.userId, { email, displayName, passwordHash });
    if (!user) {
      return json({ error: 'Pengguna tidak ditemukan' }, { status: 404 });
    }

    if (email && existingUser.email !== user.email) {
      await deleteEmailRoutingRulesForUser(platform?.env, existingUser.email, platform?.env?.DB).catch(() => undefined);
      await ensureEmailRoutingRuleForUser(platform?.env, user.email, platform?.env?.DB).catch(() => undefined);
    }

    return json({ ok: true, user });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes('unique') || message.toLowerCase().includes('users.email')) {
      return json({ error: 'Email sudah ada' }, { status: 409 });
    }
    if (message.includes('DB binding is required')) {
      return json({ error: 'Database belum dikonfigurasi' }, { status: 503 });
    }

    return json({ error: 'Gagal memperbarui pengguna' }, { status: 500 });
  }
};

export const DELETE: RequestHandler = async ({ platform, params, request, locals }) => {
  if (locals.sessionRole !== 'owner') {
    return json({ error: 'Akses ditolak' }, { status: 403 });
  }

  if (locals.sessionUserId && locals.sessionUserId === params.userId) {
    return json({ error: 'Tidak bisa menghapus pengguna yang sedang aktif' }, { status: 400 });
  }

  const confirmation = request.headers.get('x-mailflare-confirm');
  if (confirmation !== 'soft-delete-user' && confirmation !== 'delete-user') {
    return json({ error: 'Header konfirmasi hapus belum dikirim' }, { status: 400 });
  }

  try {
    const existingUser = await getUserByIdFromDb(platform?.env?.DB, params.userId);
    if (!existingUser) {
      return json({ error: 'Pengguna tidak ditemukan' }, { status: 404 });
    }

    const routing = await deleteEmailRoutingRulesForUser(platform?.env, existingUser.email, platform?.env?.DB).catch((error) => ({
      ok: false,
      skipped: false,
      deletedRuleIds: [],
      message: error instanceof Error ? error.message : String(error)
    }));
    const aliasRouting = existingUser.outlookForwardingAddress
      ? await deleteEmailRoutingRulesForUser(platform?.env, existingUser.outlookForwardingAddress, platform?.env?.DB).catch((error) => ({
          ok: false,
          skipped: false,
          deletedRuleIds: [],
          message: error instanceof Error ? error.message : String(error)
        }))
      : null;

    const result = await softDeleteUserInDb(platform?.env?.DB, params.userId);
    if (!result.deleted && result.reason === 'not_found') {
      return json({ error: 'Pengguna tidak ditemukan' }, { status: 404 });
    }
    if (!result.deleted && result.reason === 'protected_owner') {
      return json({ error: 'Akun pemilik tidak bisa dinonaktifkan' }, { status: 400 });
    }
    if (!result.deleted && result.reason === 'already_deleted') {
      return json({ ok: true, alreadyDeleted: true });
    }

    return json({
      ok: true,
      routing: {
        ok: routing.ok && (aliasRouting?.ok ?? true),
        skipped: routing.skipped && (aliasRouting?.skipped ?? true),
        deletedRuleIds: [...routing.deletedRuleIds, ...(aliasRouting?.deletedRuleIds ?? [])],
        message: aliasRouting?.message ? `${routing.message}; ${aliasRouting.message}` : routing.message
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('DB binding is required')) {
      return json({ error: 'Database belum dikonfigurasi' }, { status: 503 });
    }

    return json({ error: 'Gagal menonaktifkan pengguna' }, { status: 500 });
  }
};
