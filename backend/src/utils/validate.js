const ApiError = require('./ApiError');

// validate({ body, params, query }) - each value is an optional Zod schema.
// On success, req.body/params/query are replaced with the parsed (and
// coerced/defaulted) values. On failure, responds 400 with field-level detail.
function validate(schemas) {
  return (req, res, next) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.params) req.params = schemas.params.parse(req.params);
      if (schemas.query) req.query = schemas.query.parse(req.query);
      next();
    } catch (err) {
      const details = err.errors
        ? err.errors.map((e) => ({ field: e.path.join('.'), message: e.message }))
        : undefined;
      next(ApiError.badRequest('Некорректные данные запроса', details));
    }
  };
}

module.exports = validate;
