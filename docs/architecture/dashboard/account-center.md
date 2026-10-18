# Account Center Design

**Status:** accepted design
**Scope:** Private Cloud deployment only

## Information architecture

Account Center is a page-level workspace, not a small menu or modal. The account menu remains a compact identity/shortcut surface.

### Profile

- display name, email, avatar/initials;
- identity Provider name;
- links to Provider-managed profile, password, MFA, and Passkey screens;
- no password or MFA implementation inside Runtime Host.

### Sessions and devices

- current Session marker;
- server-derived device label;
- created, last active, and expiry times;
- revoke another Session;
- sign out this device;
- sign out all devices;
- explicit Provider-wide logout where supported;
- expiry warning before the current Session becomes unusable.

### Notifications

The existing notification-device controls remain under Personal Settings but are linked from Account Center. Login Sessions and Push devices are different records and must not be conflated.

### Data and legal

- export account/Unit data with progress and downloadable result;
- delete account with impact summary, reauthentication, grace period, and explicit Unit-data semantics;
- Privacy Policy, Terms of Service, Support, version/build, and deployment information.

## Settings grouping

- **Personal:** Interface, Language, Notifications, notification devices.
- **Workspace:** Workspace lifecycle, Executor connectivity, File/Git behavior.
- **Agent:** Model, approval, prompt/preset.
- **Administration:** Provider/runtime/socket diagnostics, shown only when deployment mode and authorization permit.

Private Cloud ordinary users must not see operator controls they cannot use. Dedicated retains operator controls without pretending an end-user account exists.

## State requirements

Every Account Center and Settings action supports loading, success, empty, unsupported, error, retry, authorization denied, and reload persistence where durable. Raw identity-provider or backend JSON errors are not displayed.

## Acceptance

- direct deep link and browser refresh restore the selected Account section;
- mobile body scrolls independently with header/actions usable;
- revoking a Session immediately produces 401 on that device;
- logout-all affects two isolated browser contexts;
- foreign Session IDs return 404;
- account data never appears in Runtime Host Unit files;
- all temporary acceptance identities and resources are deleted.
