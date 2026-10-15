// A typed error the errorHandler middleware knows how to render as a clean
// JSON response. Any error thrown that is NOT an ApiError is treated as an
// unexpected 500 and its details are hidden from the client in production.
class ApiError extends Error {
  constructor(statusCode, message, details = undefined) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message, details) {
    return new ApiError(400, message, details);
  }

  static unauthorized(message = 'Требуется авторизация') {
    return new ApiError(401, message);
  }

  static forbidden(message = 'Доступ запрещён', details) {
    return new ApiError(403, message, details);
  }

  static notFound(message = 'Не найдено') {
    return new ApiError(404, message);
  }

  static conflict(message, details) {
    return new ApiError(409, message, details);
  }
}

module.exports = ApiError;
