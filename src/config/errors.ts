export class ConfigError extends Error {
  constructor(message = '配置错误') {
    super(message)
    this.name = 'ConfigError'
    Object.setPrototypeOf(this, ConfigError.prototype)
  }
}

export class ValidationError extends Error {
  constructor(message = '配置验证失败') {
    super(message)
    this.name = 'ValidationError'
    Object.setPrototypeOf(this, ValidationError.prototype)
  }
}

export class CredentialsError extends Error {
  constructor(message = '凭证错误') {
    super(message)
    this.name = 'CredentialsError'
    Object.setPrototypeOf(this, CredentialsError.prototype)
  }
}
