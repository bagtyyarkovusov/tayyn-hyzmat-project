// External vendor boundary only. Internal API, auth, GPS and PostgreSQL stay real.
if (
  process.env.NODE_ENV !== "test" ||
  process.env.DISPOSABLE_BROWSER_TEST !== "true"
) {
  throw new Error(
    "Synthetic Geocoder must only load in disposable browser tests",
  );
}
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== "https://geocode-maps.yandex.ru")
    return original(input, init);
  const point = url.searchParams.get("geocode");
  if (point === "58.321234,37.961234") {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return Response.json({
      response: {
        GeoObjectCollection: {
          featureMember: [
            {
              GeoObject: {
                metaDataProperty: {
                  GeocoderMetaData: {
                    Address: {
                      Components: [
                        { kind: "street", name: "Synthetic street" },
                        { kind: "house", name: "12" },
                      ],
                    },
                  },
                },
              },
            },
          ],
        },
      },
    });
  }
  return Response.json({
    response: { GeoObjectCollection: { featureMember: [] } },
  });
};
