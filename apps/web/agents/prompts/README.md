# Role prompts moved

The role prompt templates now live in
[`apps/api/convex/lib/prompts/roles/`](../../../api/convex/lib/prompts/roles/),
next to the other agent seed prompts, so the Convex backend, the worker and the
web app all read the same text.

Edit the `.md` file there, then run `npm run prompts:roles` to regenerate
`apps/api/convex/lib/prompts/rolePrompts.data.ts`. A test fails when the two
drift apart.
