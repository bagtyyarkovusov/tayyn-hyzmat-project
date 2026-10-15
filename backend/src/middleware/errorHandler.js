const { Prisma } = require('@prisma/client');
const ApiError = require('../utils/ApiError');
const logger = require('../config/logger');
const env = require('../config/env');

function notFoundHandler(req, res) {
  res.status(404).json({ message: `Маршрут ${req.method} ${req.originalUrl} не найден` });
}

// Centralized error -> HTTP response mapping. Must be the LAST middleware
// registered on the app.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({ message: err.message, details: err.details });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      return res.status(409).json({ message: 'Запись с такими данными уже существует', details: err.meta });
    }
    if (err.code === 'P2025') {
      return res.status(404).json({ message: 'Запись не найдена' });
    }
  }

  logger.error({ err, path: req.originalUrl, method: req.method }, 'Unhandled error');

  res.status(500).json({
    message: 'Внутренняя ошибка сервера',
    ...(env.isProduction ? {} : { stack: err.stack, error: err.message })
  });
}

module.exports = { errorHandler, notFoundHandler };
