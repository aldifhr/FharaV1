# Third-party notices

Fhara includes portions adapted from the following projects.

## t3code

- Source: https://github.com/pingdotgg/t3code
- Used in: `apps/api/convex/lib/eventResume.ts` (`decideResume` / `replayEncodedBytes`, adapted from
  `apps/server/src/orchestration-v2/ThreadStream.ts` `decideThreadResume` / `threadReplayEncodedBytes`).
  Other t3code-inspired changes (sequenced events, idempotent sends, durable chat replies) take the ideas only.

```
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## 9router

- Source: https://github.com/decolua/9router (commit `1339107`)
- Used in: `apps/api/convex/lib/llmRotation.ts`: `StickyRotationCursor` / `rotateFrom` (adapted from
  `open-sse/services/combo.js` `getRotatedModels` / `normalizeStickyLimit` / `rotateModelsFromIndex`),
  `isEmptyCompletion` (from `isZeroContentResponse`, same file), and `cooldownForFailure` /
  `rateLimitCooldownMs` (from `open-sse/services/accountFallback.js` `checkFallbackError` /
  `getQuotaCooldown` and the rules in `open-sse/config/errorConfig.js`). Rewritten in TypeScript and reduced.
  The Settings → LLM & Models provider presets and the validate-on-save / Test flow take the ideas only.

```
MIT License

Copyright (c) 2024-2026 decolua and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
