---
"filesystem-routing": patch
---

`createAPIHandler` treats a `HEAD` request whose `GET` handler declines (returns `undefined`) the same as the `GET` itself: a page falls through to the chain and a handler-only route answers 404. It previously threw "did not return a response", which surfaced as a 500 to link checkers, monitors and crawlers that send `HEAD`.
