# GenDragoonSSD — Owner-managed Advertisements

Edit [ads.json](./ads.json) directly in GitHub's `main` branch to publish ad-content updates **without rebuilding the native app**. Use GitHub's **Edit** pencil, change the JSON, then **Commit changes**. The app checks the published manifest when loading and when users change pages; ordinary GitHub CDN caching may delay propagation.

Every ad has:
- `id`: unique stable machine-readable identifier.
- `title`: visible headline.
- `description`: short public-facing explanation.
- `link`: optional HTTPS destination. Remove the property or use `null` to make the ad non-clickable.

Example:
```json
{
  "id": "infectednation-vocal-lab",
  "title": "The ultimate Vocal lab and artists community",
  "description": "Bring your beats and vocals together with Infected Vocals—tools for mixing, mastering, vocal effects, and a creative community for independent artists.",
  "link": "https://infectedNation.net/"
}
```

Important:
1. The document must remain valid JSON with `schemaVersion: 1` and an `ads` array.
2. Increment `revision` for each content update; it helps you audit ad revisions.
3. **Zero** valid ads -> no ad placements; **one** -> repeat in top and sidebar; **two or more** -> choose two distinct ads, randomly refreshed on navigation or on app refresh.
4. Only URL destinations beginning with `https://` or `http://` are allowed. Avoid misleading or malicious links, unsupported claims, and private account details.
5. The app must honor the owner's once-paid **Remove Ads** entitlement: no ads for that account.
6. GitHub content commits are **content updates**; they do not silently replace installed, signed app binaries.
7. Do not put Stripe secrets, API tokens, private customer information, or storage keys into ads.json or any public repository file.
