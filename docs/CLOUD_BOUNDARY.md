# Optional cloud service boundary

> Status: architecture proposal. Daily Planner currently has no account system or cloud database.

Daily Planner should remain a complete local-first planner. Cloud functionality, if offered, is an optional service around that local product rather than a requirement for using Day, Week, Horizon, Journal, Unresolved, or local backups.

## Repository boundary

```text
daily-planner/                 public, source-available
├─ local planner runtime
├─ local persistence
├─ offline/PWA behavior
├─ import/export
├─ sync client contract       future
└─ UI for optional account    future

daily-planner-cloud/           private, future
├─ authentication
├─ sync API
├─ conflict resolution
├─ encrypted backups
├─ billing / entitlements
├─ email / account operations
├─ calendar integrations
└─ deployment / monitoring
```

The private service should not be implemented as secret JavaScript injected into the public client. Code shipped to a browser is inspectable. The durable boundary is an API: the public client knows how to request synchronization, while the private service owns how accounts, persistence, operations, and billing are implemented.

## Product principles

1. **Local first.** Creating an account must never be required to use the core planner.
2. **Offline capable.** Losing a network connection must not stop planning or editing local data.
3. **Explicit sync state.** The UI should distinguish local state, pending changes, and confirmed remote state.
4. **Stable identifiers.** Synced entities need durable IDs rather than relying only on dates or array positions.
5. **Deletion is data.** A sync protocol needs tombstones/version metadata so deletions do not silently reappear on another device.
6. **Conflicts are expected.** Concurrent edits across devices must have a defined merge or conflict policy.
7. **The server is not the UI.** Business-critical server behavior stays behind the API; presentation stays in the public client.
8. **Export remains available.** Paid cloud services must not make user data hostage to the service.

## Likely paid service value

An official hosted service could eventually provide:

- multi-device synchronization;
- automatic encrypted backups;
- restore/history;
- account recovery;
- calendar integrations;
- operational monitoring and reliability;
- future collaboration or automation services where they fit the product.

Those are service and infrastructure benefits. The local planner should not be intentionally degraded to manufacture an upgrade reason.

## Before implementation

The first engineering task is not authentication or billing. It is defining a sync-safe local data model and protocol:

- stable entity IDs;
- revision/version metadata;
- mutation timestamps or logical clocks;
- deletion/tombstone semantics;
- an API payload format;
- conflict resolution rules;
- migration/versioning strategy.

Only after that contract is tested should a cloud backend be built.
