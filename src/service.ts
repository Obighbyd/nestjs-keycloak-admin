import { Logger, InternalServerErrorException, Global } from '@nestjs/common'
import AdminClient from 'keycloak-admin'
import { Client, Issuer, TokenSet } from 'openid-client'
import { resolve } from 'url'
import { ResourceManager } from './lib/resource-manager'
import { PermissionManager } from './lib/permission-manager'
import { KeycloakModuleOptions } from './@types/package'
import KeycloakConnect, { Keycloak } from 'keycloak-connect'
import { RequestManager } from './lib/request-manager'
import { UMAConfiguration } from './@types/uma'

@Global()
export class KeycloakService {
  private logger = new Logger(KeycloakService.name)

  private tokenSet?: TokenSet
  private issuerClient?: Client

  private baseUrl: string
  private requestManager: RequestManager
  public umaConfiguration?: UMAConfiguration
  public readonly options: KeycloakModuleOptions

  public connect: Keycloak
  public permissionManager!: PermissionManager
  public resourceManager!: ResourceManager
  public client: AdminClient

  constructor(options: KeycloakModuleOptions) {
    if (!options.config.baseUrl.startsWith('http')) {
      throw new Error(`Invalid base url. It should start with either http or https.`)
    }
    this.options = options
    this.baseUrl = resolve(options.config.baseUrl, `/auth/realms/${options.config.realmName}`)

    const keycloak: any = new KeycloakConnect({}, {
      resource: this.options.credentials.clientId,
      realm: this.options.config.realmName,
      'confidential-port': 0,
      'ssl-required': 'all',
      'auth-server-url': resolve(this.options.config.baseUrl, '/auth'),
      secret: this.options.credentials.clientSecret,
    } as any)

    keycloak.accessDenied = (req: any, _res: any, next: any) => {
      req.accessDenied = true
      next()
    }

    this.connect = keycloak as Keycloak
    this.client = new AdminClient(this.options.config)

    this.requestManager = new RequestManager(this, this.baseUrl)
  }

  async initialize(): Promise<void> {
    if (this.umaConfiguration) {
      return
    }
    const { clientId, clientSecret } = this.options.credentials
    const { data } = await this.requestManager.get<UMAConfiguration>(
      '/.well-known/uma2-configuration'
    )
    this.umaConfiguration = data

    this.resourceManager = new ResourceManager(this, data.resource_registration_endpoint)
    this.permissionManager = new PermissionManager(this, data.token_endpoint)

    await this.client.auth({
      clientId,
      clientSecret,
      grantType: 'client_credentials',
    } as any)

    const keycloakIssuer = await Issuer.discover(data.issuer)

    this.issuerClient = new keycloakIssuer.Client({
      client_id: clientId,
      client_secret: clientSecret,
    })

    this.tokenSet = await this.issuerClient.grant({
      clientId,
      clientSecret,
      grant_type: 'client_credentials',
    })

    if (this.tokenSet.expires_at) {
      this.logger.log(`Initial token expires at ${this.tokenSet.expires_at}`)
    }
  }

  async refreshGrant(): Promise<TokenSet | undefined | null> {
    if (this.tokenSet && !this.tokenSet.expired()) {
      return this.tokenSet
    }

    if (!this.tokenSet) {
      this.logger.error(`Token set is missing. Could not refresh grant.`)
      return null
    }

    const { refresh_token } = this.tokenSet

    this.logger.verbose(`Grant token expired, refreshing.`)

    if (!refresh_token) {
      this.logger.error(`Could not refresh token. Refresh token is missing.`)
      return null
    }

    this.tokenSet = await this.issuerClient?.refresh(refresh_token)

    if (this.tokenSet?.access_token) {
      this.client.setAccessToken(this.tokenSet.access_token)
    }

    return this.tokenSet
  }
}
