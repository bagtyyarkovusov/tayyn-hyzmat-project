# Yandex reverse geocoding setup

Researched 2026-10-15. Documentation research only; no vendor account, billing, Railway variables or deployment changed.

## What is failing

The location implementation agent reports that the actual Railway page loads Yandex Maps SDK 2.1.79, but `ymaps.geocode([latitude, longitude])` rejects with `scriptError`. A direct HTTP request with that same SDK key returns HTTP 403 and `Invalid apikey`. This is observed integration evidence, not an inspection of the owner's Yandex account. Yandex documents 403 as an invalid API key; the response alone does not establish whether the account has the wrong product link, an inactive key, a plan issue or a restriction mismatch. [Geocoder response errors](https://yandex.com/maps-api/docs/geocoder-api/response.html)

A working map does not establish geocoder access: Yandex explicitly says that restrictions can leave the map visible while billable operations fail. [API key restrictions](https://yandex.com/maps-api/docs/js-api/limit.html)

## Owner setup steps

1. Open the [Yandex Maps developer dashboard](https://developer.tech.yandex.com/) and sign in using the business's Yandex ID. This redirects to the Maps API console; a Yandex Cloud IAM key is not the credential requested by these Maps docs.
2. On first entry, select the real country of tax residency and payment. The dashboard guide says this choice cannot subsequently be changed. Do not select Russia or Kazakhstan merely to bypass an unavailable option.
3. Click **Connect API / Подключить API**, then select **Geocoder API / API Геокодера**. Current standalone geocoder documentation calls it the Geocoder API package. Other official JavaScript pages still call the combination **JavaScript API and Geocoder HTTP**. Confirm that the connected service actually includes HTTP reverse geocoding rather than merely map display.
4. Choose the plan or request an appropriate test period. Complete the payer/invoice steps when required. Paid access starts after funds arrive and the selected plan start date is reached.
5. In **Keys / Ключи**, confirm the key is active and linked to the geocoder product. Existing keys can be linked to another connected product: choose the key, **Link to API / Привязать к API**, choose the connected API, then select it. Alternatively, create a separate geocoder key for the backend.
6. Save restrictions and allow up to **15 minutes** for key activation or restriction changes before retesting.

Sources: [Current dashboard setup](https://yandex.com/maps-api/docs/developer/quickstart.html), [Geocoder quick start](https://yandex.com/maps-api/docs/geocoder-api/quickstart.html), [JavaScript quick start with combined package name](https://yandex.com/maps-api/docs/js-api/quickstart.html), [Key/product linking and block controls](https://yandex.ru/maps-api/docs/common/developer-account.html), [Restriction propagation](https://yandex.com/maps-api/docs/js-api/limit.html).

No official source reviewed establishes that all Turkmenistan accounts are ineligible. Account-specific country/payment availability remains to be checked in the console or with Yandex support. Selecting a country is different from address coverage in that country.

## Plan and usage fit

This is a restricted driver/dispatcher and monitoring application. Yandex's commercial FAQ explicitly lists restricted applications and monitoring systems as commercial use cases. Request a trial suitable for this closed application before purchasing; do not assume a generally advertised free allowance authorizes it. The current international product page says trial terms for smaller volumes are negotiated individually through **api-maps@yandex-team.ru**. We must obtain the actual account offer and cost rather than promise a free quota or price from another region. [Commercial FAQ](https://yandex.com/dev/commercial/doc/en/concepts/faq), [Current international Geocoder product and trial information](https://yandex.com/maps-api/products/geocoder-api)

The general terms require open access unless otherwise agreed; geocoder use is tied to Yandex JavaScript Maps and cannot be displayed on another vendor's map. These terms also specify mobile app identification through a `.ymapapp` Referer. Their stated 1,000 daily geocoder requests are conditional, not an unconditional free allowance for our application. [General terms, sections 2.4, 4.1 and 6.6](https://yandex.ru/legal/maps_api/en/)

Commercial Geocoder terms explicitly permit closed platforms. They distinguish temporary performance caching for up to 30 days under the specified standard license from storage for the license term under an extended license. Confirm that our intended address-only dashboard display, attribution and any caching are covered by the selected agreement. Do not persist vendor addresses indefinitely by default. [Commercial Geocoder terms, sections 1.1, 2.1 and 2.2](https://yandex.ru/dev/tariffs/doc/en/geocoder/terms/)

## Browser and APK restrictions

For browser JavaScript, use domain/HTTP Referer restrictions for the actual Railway/custom website origins. An IP restriction evaluates the driver's public device IP, not the website hosting IP, so allowlisting Railway's IP would break direct mobile browser calls. A restricted server request must supply a matching Referer when a domain check is configured. [Restriction semantics](https://yandex.com/maps-api/docs/js-api/limit.html)

Capacitor's defaults are hostname `localhost` and Android scheme `https`, so a bundled app ordinarily runs at `https://localhost`, not the Railway frontend origin. Inspect the actual APK configuration and emitted Referer before configuring browser restrictions. Do not assume a browser-working key will also work in the APK. Capacitor's `server.url` is intended for development live reload, not production hosting. [Capacitor configuration](https://capacitorjs.com/docs/config)

Recommended architecture, subject to the confirmed license: phone GPS → authenticated backend reverse-geocode endpoint → Yandex HTTP Geocoder → short display address. A separate private HTTP key stays on Railway; the APK never receives it. The backend should validate coordinates, rate-limit requests, handle deadlines and vendor errors, and leave GPS/region matching usable when address lookup fails. This is an engineering recommendation, not existing implementation.

If restricting that server key by IP, use stable outbound egress addresses. A Railway public domain or inbound address is not its outbound identity. Railway offers static outbound IPv4 addresses on its Pro plan; allowlist all assigned service addresses if using this option. Otherwise establish an approved alternative restriction/egress arrangement before locking the key to an observed temporary IP. [Railway static outbound IPs](https://docs.railway.com/networking/static-outbound-ips)

## Configuration and acceptance checks

Existing frontend code supports `VITE_YANDEX_MAPS_API_KEY` with legacy `VUE_APP_YANDEX_MAPS_API_KEY`; these are public build variables and changing them requires rebuilding the frontend/APK. They belong to map display and the current browser lookup. A proposed backend adapter would introduce a distinct secret such as `YANDEX_GEOCODER_API_KEY`; that variable is not implemented merely by this document. Configure secrets in Railway Variables or an ignored local environment file, never a Git commit or chat message.

The current HTTP documentation uses `https://geocode-maps.yandex.ru/v1/`. An example validation request uses `geocode=58.3261,37.9601`, `lang=ru_RU`, `format=json` and a valid `apikey`. HTTP defaults to longitude,latitude; browser SDK 2.1 calls use latitude,longitude. Do not interchange them. Inspect returned address components and precision, and never invent a building when Yandex only resolves a street/locality. [HTTP request format](https://yandex.com/maps-api/docs/geocoder-api/request.html), [SDK 2.1 geocode reference](https://yandex.com/dev/jsapi-v2-1/doc/en/v2-1/ref/reference/geocode)

After configuration, verify HTTP 200 with useful address results for several actual Ashgabat points, then verify the Railway browser and installed APK. Check unavailable-address, outside-region, denied GPS and vendor-failure cases. Custom dispatch regions must continue to use our saved polygons; a Yandex district label must never replace those boundaries. These are project acceptance recommendations, not claims of completed testing.
