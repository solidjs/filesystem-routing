---
"filesystem-routing": patch
---

In server-consumer environments, the Vite adapter now imports a server page's module (`server: true`) by its plain id instead of `?pick=...`, for every ref to that file. The server-function handler already imports the file whole, so a picked copy was a second module instance that registered the page's server function again under the same id. That second registration dropped the GET grant `@solidjs/router` makes, so client navigation to server pages answered 405. Client environments still pick.
