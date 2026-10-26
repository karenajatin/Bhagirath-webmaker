# LiveShop

Online store + private shop panel.

- Store (public): https://karenajatin.github.io/Bhagirath-webmaker/
- Shop panel (staff login): https://karenajatin.github.io/Bhagirath-webmaker/panel/

Products, prices and photos are managed in the shop panel. The GitHub Action
`.github/workflows/build-store.yml` rebuilds the Google-friendly product pages
(`/p/<item>/`), category pages (`/c/<category>/`) and `sitemap.xml` every 6 hours
from the public catalog (and on every push, or by hand from the Actions tab).

Settings live in `firebase-config.js` (Firebase web config, `SITE_URL`,
`STORE_SHOP_ID`, `ALLOW_NEW_SHOPS`, `GOOGLE_SITE_VERIFICATION`).
