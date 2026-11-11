# Status page API proxy

Cloudflare Worker that answers the status page's GitHub API reads from a shared cache, so visitors
never hit GitHub's 60-requests-per-hour-per-IP limit (the "Rate limit exceeded" page).

- Only `GET` reads of this repo's issues, comments, commits and contents; everything else is refused.
- One upstream call per URL per minute, sent with our token; if GitHub fails, the last good copy
  (kept 24 h) is served instead of an error.
- CORS only for https://status.apphivesl.com.

```bash
cd proxy
npm test                                   # unit tests (node --test)
npx wrangler@3.80.0 dev                    # run locally on :8787
npx wrangler@3.80.0 login                  # once
npx wrangler@3.80.0 secret put GITHUB_TOKEN  # once: fine-grained token, public repos read-only
npx wrangler@3.80.0 deploy
```

Then set `status-website.apiBaseUrl` in `.upptimerc.yml` to the Worker's URL.
