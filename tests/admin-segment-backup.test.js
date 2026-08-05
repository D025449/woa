import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAdminSegmentBackup,
  decodeAdminSegmentBackup,
  resolveAdminSegmentOwners
} from "../src/services/adminSegmentBackupService.js";

function segment(id, uid, authSub, email, offset = 0) {
  const track = [
    { lat: 48.5 + offset, lng: 9 + offset, ele: 400 },
    { lat: 48.501 + offset, lng: 9.001 + offset, ele: 410 }
  ];
  return {
    id,
    uid,
    ownerAuthSub: authSub,
    ownerEmail: email,
    distance: 135,
    duration: 30,
    ascent: 10,
    start: { ...track[0], name: "Start", altitude: 400 },
    end: { ...track[1], name: "End", altitude: 410 },
    track
  };
}

test("admin segment backup preserves owner identities and segment tracks", async () => {
  const archive = buildAdminSegmentBackup([
    segment(1, 7, "dev-a", "A@example.com"),
    segment(2, 8, "dev-b", "b@example.com", 0.1)
  ]);
  const decoded = await decodeAdminSegmentBackup(archive);

  assert.equal(decoded.owners.length, 2);
  assert.equal(decoded.segments.length, 2);
  assert.equal(decoded.owners[0].email, "a@example.com");
  assert.equal(decoded.segments[0].segment.track.length, 2);
});

test("admin segment owner mapping prefers auth_sub and falls back to email", () => {
  const mappings = resolveAdminSegmentOwners([
    { key: "a", authSub: "stable-sub", email: "old@example.com", sourceUid: "1", declaredSegmentCount: 2 },
    { key: "b", authSub: "dev-only-sub", email: "same@example.com", sourceUid: "2", declaredSegmentCount: 3 }
  ], [
    { id: 10, auth_sub: "stable-sub", email: "new@example.com" },
    { id: 11, auth_sub: "prod-sub", email: "SAME@example.com" }
  ]);

  assert.equal(mappings[0].targetUid, "10");
  assert.equal(mappings[0].matchMethod, "auth_sub");
  assert.equal(mappings[1].targetUid, "11");
  assert.equal(mappings[1].matchMethod, "email");
});

test("admin segment owner mapping blocks contradictory and ambiguous identities", () => {
  const mappings = resolveAdminSegmentOwners([
    { key: "conflict", authSub: "sub-a", email: "b@example.com", declaredSegmentCount: 1 },
    { key: "ambiguous", authSub: "missing", email: "duplicate@example.com", declaredSegmentCount: 1 }
  ], [
    { id: 1, auth_sub: "sub-a", email: "a@example.com" },
    { id: 2, auth_sub: "sub-b", email: "b@example.com" },
    { id: 3, auth_sub: "sub-c", email: "duplicate@example.com" },
    { id: 4, auth_sub: "sub-d", email: "DUPLICATE@example.com" }
  ]);

  assert.equal(mappings[0].status, "conflict");
  assert.equal(mappings[1].status, "conflict");
});

test("an exact auth_sub remains authoritative when an email is not unique", () => {
  const [mapping] = resolveAdminSegmentOwners([
    { key: "owner", authSub: "stable", email: "duplicate@example.com", declaredSegmentCount: 1 }
  ], [
    { id: 1, auth_sub: "stable", email: "duplicate@example.com" },
    { id: 2, auth_sub: "other", email: "DUPLICATE@example.com" }
  ]);

  assert.equal(mapping.status, "matched");
  assert.equal(mapping.matchMethod, "auth_sub");
  assert.equal(mapping.targetUid, "1");
});
