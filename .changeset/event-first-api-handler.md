---
"filesystem-routing": patch
---

`createAPIHandler` takes the request event as its first argument as well as the request, so it drops into event-first chains such as `@solidjs/vite-plugin`'s `start.middleware`, where the documented `export default [createAPIHandler(routes)]` failed every request with `TypeError: Invalid URL` (the event has no `url`). Given an event, handlers receive that event with the matched `params` written onto it, and no request-event scope is needed; `getEvent` still takes precedence. `(request, next)` chains behave as before.
