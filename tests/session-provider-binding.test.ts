import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate DB to a temp dir
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-provider-test-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async () => {
  return {
    STORE_DIR: tmpStoreDir,
    GROUPS_DIR: tmpGroupsDir,
  };
});

const {
  initDatabase,
  setSession,
  getSessionProviderId,
  setSessionProviderId,
  deleteSession,
} = await import('../src/db.js');

beforeAll(() => {
  initDatabase();
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('session→provider sticky binding', () => {
  test('returns undefined for unknown session', () => {
    expect(getSessionProviderId('unknown-folder')).toBeUndefined();
    expect(getSessionProviderId('unknown-folder', 'some-agent')).toBeUndefined();
  });

  test('setSessionProviderId creates a row when none exists', () => {
    setSessionProviderId('folder-1', '', 'provider-A');
    expect(getSessionProviderId('folder-1')).toBe('provider-A');
    expect(getSessionProviderId('folder-1', '')).toBe('provider-A');
  });

  test('setSessionProviderId updates existing session row without losing session_id', () => {
    setSession('folder-2', 'session-uuid-2', '');
    setSessionProviderId('folder-2', '', 'provider-B');
    expect(getSessionProviderId('folder-2')).toBe('provider-B');

    // Switching provider must not delete the session_id binding.
    setSessionProviderId('folder-2', '', 'provider-C');
    expect(getSessionProviderId('folder-2')).toBe('provider-C');
  });

  test('agent-scoped bindings are independent of main bindings', () => {
    setSessionProviderId('folder-3', '', 'main-provider');
    setSessionProviderId('folder-3', 'agent-x', 'sub-provider');
    expect(getSessionProviderId('folder-3')).toBe('main-provider');
    expect(getSessionProviderId('folder-3', 'agent-x')).toBe('sub-provider');
  });

  test('clearing binding via null removes provider_id but keeps row', () => {
    setSessionProviderId('folder-4', '', 'provider-D');
    setSessionProviderId('folder-4', '', null);
    expect(getSessionProviderId('folder-4')).toBeUndefined();
  });

  test('deleteSession removes the binding too', () => {
    setSessionProviderId('folder-5', '', 'provider-E');
    deleteSession('folder-5', '');
    expect(getSessionProviderId('folder-5')).toBeUndefined();
  });
});
