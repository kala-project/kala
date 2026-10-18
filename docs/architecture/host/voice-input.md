# Voice input

Kala provides optional Azure Speech dictation in the Dashboard composer. It
converts microphone audio into editable text; it never sends a message
automatically and does not persist the source recording.

## Configuration

Configure the integration from **Settings → Voice Input**. The default endpoint
is `https://japaneast.api.cognitive.microsoft.com/`. Kala accepts only regional
Azure Cognitive Services HTTPS endpoints in the form
`https://<region>.api.cognitive.microsoft.com/`.

The subscription key is encrypted at rest by the Host with AES-256-GCM and
private filesystem permissions. Settings responses expose only configuration
status, transcription mode, per-mode recording limits, endpoint, region, and update time. Existing keys cannot be read back
through the Dashboard API.

## Transcription modes

- **Live transcription** is the default. The authenticated Dashboard gets an
  Azure-issued short-lived token from `POST /runtime/speech/token`, then the
  official Microsoft Speech SDK streams microphone audio directly from the
  browser to Azure. Finalized text remains visible while the latest partial
  phrase updates. When voice input is enabled, Kala preloads the SDK after
  configuration is known and may obtain a short-lived token when the user
  hovers, focuses, or presses the microphone control. Microphone capture itself
  never starts until the user activates Record.
- **Transcribe after recording** keeps the recording in browser memory until
  Stop. The Dashboard sends the audio to `POST /runtime/speech/transcribe`; the
  Host forwards it in memory to Azure Fast Transcription API
  `2025-10-15`. Neither the Dashboard nor Host writes the audio to disk.

Both modes use `zh-CN` and `en-US` language candidates. Settings provide separate
**Live transcription limit** and **After-recording limit** controls (1–120 minutes,
both default to 15). Each automatically stops and commits the recognized text at
its limit without sending the message. The live limit guards against forgotten
microphones and unexpected Azure charges; it is a Kala policy, not an Azure
five-minute continuous recognition cap. A long after-recording upload may also
hit the Host's 25 MiB request limit. Already typed text remains visible in the
recorder while new speech is captured. Canceling deliberately
discards only the current recording and restores the original draft. A failed
after-recording request retains its in-memory Blob only long enough to support
Retry or Dismiss.

Clicking the recorder Stop control stops and commits transcription without
sending. Holding that control and dragging it right past the visible threshold
waits for final transcription, merges it into the draft, and then sends the
result. Releasing below the threshold cancels the gesture without stopping or
sending, which prevents an incidental pointer movement from submitting text.

Credential changes and connection tests use the same management authorization
policy as other sensitive settings. In multi-tenant deployments they require an
ingress owner or administrator. Token requests require an authenticated,
writable Dashboard actor.

## Operational boundaries

- Audio recordings are not written to Session logs, local storage, artifacts,
  or Host files.
- Azure billing is not shown in Kala. Accurate cost data requires Azure RBAC and
  Cost Management scope beyond a Speech subscription key.
- The browser must run over HTTPS and permit microphone access. Browsers also
  treat `http://localhost` as a secure development exception, but ordinary HTTP
  hostnames and IP addresses cannot use voice input.
- On Linux Desktop, Kala shows a native microphone confirmation for the
  connected, verified Dashboard origin. Approval applies only to audio for the
  current application process; camera and unrelated WebKit permission requests
  remain denied or unhandled.
- Desktop Content Security Policy permits only Azure regional Speech HTTPS and
  Speech-to-text WebSocket destinations.
