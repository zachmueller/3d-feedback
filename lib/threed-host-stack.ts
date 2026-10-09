import * as path from 'path';
import {
  Stack,
  StackProps,
  Duration,
  RemovalPolicy,
  CfnOutput,
  SecretValue,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import {
  HttpUserPoolAuthorizer,
  HttpIamAuthorizer,
} from 'aws-cdk-lib/aws-apigatewayv2-authorizers';

// Preview runtime (no SLA). Swap to lambda.Runtime.NODEJS_26_X once CDK ships it
// at GA; rolling back means NODEJS_24_X, the newest GA runtime.
const NODE_RUNTIME = new lambda.Runtime('nodejs26.x', lambda.RuntimeFamily.NODEJS);

/**
 * Single-stack implementation of the 3D model host (3d.zach.nz).
 *
 * Share URLs are project + revision, not one-off UIDs:
 *
 *   /<project>          -> viewer, redirected client-side to the latest revision
 *   /<project>/<rev>    -> viewer for that revision
 *
 * One viewer SPA under `viewer/` serves every project/revision; a CloudFront
 * function rewrites both URL shapes to `/viewer/index.html` and the viewer reads
 * the project manifest (`/projects/<slug>.json`) to find the GLB, the revision
 * list, and the comment thread. Per-revision HTML was rejected deliberately:
 * a viewer fix would not reach already-published revisions.
 *
 * Because CloudFront selects a cache behavior BEFORE the viewer-request function
 * rewrites the URI, `/­<project>/<rev>` is served by the DEFAULT behavior. The
 * default behavior therefore carries a short TTL, and the only long-lived cache
 * is the dedicated `*.glb` behavior (revision content is immutable).
 *
 * Dependency direction (kept acyclic, all within one stack):
 *
 *   buckets ─▶ distribution ─┬▶ Cognito callback URLs
 *                            ├▶ HTTP API CORS allowOrigins
 *                            ├▶ Lambda env (DISTRIBUTION_ID)
 *                            └▶ config.json ─▶ BucketDeployment
 */
export class ThreedHostStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // --- context / config ---------------------------------------------------
    const allowedEmails = this.ctx('threedHost:allowedEmails', 'you@example.com');
    // Read-only accounts: they sign in with Google the same way, see the published
    // catalog at /browse, and are refused by every admin route. Blank by default,
    // so a deployment that wants no readers creates none.
    const viewerEmails = this.ctx('threedHost:viewerEmails', '');
    const hostedUiPrefix = this.ctx('threedHost:hostedUiPrefix', 'threed-host-admin');
    const domainName = this.ctx('threedHost:domainName', '3d.zach.nz');
    // This subdomain is served straight from the parent `zach.nz` zone, which
    // lives in a separate `domains` account — one zone for the whole domain
    // instead of a delegated zone per app. CloudFormation cannot write records
    // into another account's zone, and neither can ACM's automatic DNS
    // validation, so tools/parent-dns.sh owns both records (the CloudFront alias
    // and the ACM validation CNAME). Until the validation record exists the
    // certificate cannot be issued, so the domain stays opt-in: deploy once with
    // this false, write the records, then flip it to true.
    const domainEnabled = this.ctxBool('threedHost:domainEnabled', false);
    const googleClientId = this.ctx('threedHost:googleClientId', '');
    const googleClientSecret = this.ctx('threedHost:googleClientSecret', '');

    const region = Stack.of(this).region;
    const hostedUiDomain = `${hostedUiPrefix}.auth.${region}.amazoncognito.com`;

    // =========================================================================
    // S3 buckets
    // =========================================================================

    // Everything public-facing (served only through CloudFront OAC):
    //   <slug>/<rev>/model.glb      the model itself (immutable)
    //   projects/<slug>.json        manifest: title, latest, revision list
    //   comments/<slug>/<rev>.json  public feedback thread
    //   status/<slug>/<rev>.json    publish progress, for CLI polling
    //   app/...                     admin SPA
    //   viewer/...                  viewer SPA
    const assetsBucket = new s3.Bucket(this, 'AssetsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Private metadata index — only the Lambda role ever touches it.
    const metadataBucket = new s3.Bucket(this, 'MetadataBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Raw uploads land here via presigned PUT; auto-expire after 30 days.
    // No CORS rules: the publisher is a CLI (SigV4 + presigned PUT), never a
    // browser, so this bucket does not need to know the CloudFront domain.
    const stagingBucket = new s3.Bucket(this, 'StagingBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: Duration.days(30) }],
    });

    const METADATA_KEY = 'metadata.json';

    // =========================================================================
    // CloudFront functions (viewer-request URL rewriting)
    // =========================================================================
    const cleanUrlFn = new cloudfront.Function(this, 'CleanUrlFn', {
      code: cloudfront.FunctionCode.fromFile({
        filePath: path.join(__dirname, 'cloudfront-functions', 'clean-url.js'),
      }),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'Map /<project>[/<rev>] to the viewer SPA (default behavior only)',
    });

    const adminRewriteFn = new cloudfront.Function(this, 'AdminRewriteFn', {
      code: cloudfront.FunctionCode.fromFile({
        filePath: path.join(__dirname, 'cloudfront-functions', 'admin-rewrite.js'),
      }),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'Map /login /admin to app/*.html',
    });

    // =========================================================================
    // Certificate (opt-in via threedHost:domainEnabled)
    // =========================================================================
    let certificate: acm.ICertificate | undefined;
    if (domainEnabled) {
      // No hosted zone is named, so CloudFormation waits on validation instead of
      // recording it: the validation CNAME lives in the parent zone in the other
      // account, put there by tools/parent-dns.sh. ACM reuses one validation
      // token per domain per account, so the record is written once and keeps
      // working for renewals and for any later re-request.
      certificate = new acm.Certificate(this, 'Certificate', {
        domainName,
        validation: acm.CertificateValidation.fromDns(),
      });
    }

    // =========================================================================
    // CloudFront distribution
    // =========================================================================
    const assetsOrigin = origins.S3BucketOrigin.withOriginAccessControl(assetsBucket);

    // Revision content never changes: a new revision is a new path.
    const immutableCache = new cloudfront.CachePolicy(this, 'ImmutableCache', {
      defaultTtl: Duration.days(365),
      minTtl: Duration.days(365),
      maxTtl: Duration.days(365),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    // App shells and the viewer HTML. Also the DEFAULT behavior, because
    // /<project>/<rev> is matched here before being rewritten to the viewer.
    const shortCache = new cloudfront.CachePolicy(this, 'ShortCache', {
      defaultTtl: Duration.seconds(60),
      minTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(300),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    // Near-live data: manifests (revision list), comment threads, publish status.
    const liveCache = new cloudfront.CachePolicy(this, 'LiveCache', {
      defaultTtl: Duration.seconds(5),
      minTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(10),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    const cleanUrlAssoc: cloudfront.FunctionAssociation[] = [
      { function: cleanUrlFn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
    ];
    const adminAssoc: cloudfront.FunctionAssociation[] = [
      { function: adminRewriteFn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
    ];

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: '3D model host',
      ...(domainEnabled ? { domainNames: [domainName], certificate } : {}),
      defaultBehavior: {
        origin: assetsOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: shortCache,
        functionAssociations: cleanUrlAssoc,
      },
      additionalBehaviors: {
        // The models themselves — the only long-cached objects.
        '*.glb': {
          origin: assetsOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: immutableCache,
        },
        // Manifests, comment threads, publish status.
        '/projects/*': this.liveBehavior(assetsOrigin, liveCache),
        '/comments/*': this.liveBehavior(assetsOrigin, liveCache),
        '/status/*': this.liveBehavior(assetsOrigin, liveCache),
        // Static app assets (no rewrite).
        '/viewer/*': this.liveBehavior(assetsOrigin, shortCache),
        '/app/*': this.liveBehavior(assetsOrigin, shortCache),
        // Signed-in app shells (served from app/*.html via the rewrite function).
        '/login': this.adminBehavior(assetsOrigin, shortCache, adminAssoc),
        '/admin': this.adminBehavior(assetsOrigin, shortCache, adminAssoc),
        '/browse': this.adminBehavior(assetsOrigin, shortCache, adminAssoc),
      },
      // A missing key behind OAC surfaces as 403; both map to a friendly page.
      // The viewer relies on the non-2xx status (not the body) to detect an
      // unknown project or revision, so the status code is preserved as 404.
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 404,
          responsePagePath: '/viewer/404.html',
          ttl: Duration.seconds(30),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 404,
          responsePagePath: '/viewer/404.html',
          ttl: Duration.seconds(30),
        },
      ],
      defaultRootObject: '',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    const cloudFrontDomain = distribution.distributionDomainName;
    const siteDomain = domainEnabled ? domainName : cloudFrontDomain;
    const siteUrl = `https://${siteDomain}`;

    // The A/AAAA aliases pointing here live in the parent zone, in the other
    // account: tools/parent-dns.sh --cf-domain / --stack reads this distribution's
    // domain name and UPSERTs them.

    // =========================================================================
    // Cognito (user pool + Google IdP + Hosted UI + app client)
    // =========================================================================
    const preSignUpFn = new NodejsFunction(this, 'PreSignUpFn', {
      entry: path.join(__dirname, 'lambda', 'pre-signup.ts'),
      handler: 'handler',
      runtime: NODE_RUNTIME,
      timeout: Duration.seconds(10),
      // Both lists: this trigger decides who may have an account at all, and the
      // API handler decides what each account can do with it.
      environment: { ALLOWED_EMAILS: allowedEmails, VIEWER_EMAILS: viewerEmails },
    });

    const userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false, // allowlist only; no public sign-up
      signInAliases: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      removalPolicy: RemovalPolicy.DESTROY,
      lambdaTriggers: { preSignUp: preSignUpFn },
    });

    // Google federation is only wired when credentials are supplied, so synth
    // and tests pass with blank context. Supply real values before deploy.
    let googleIdp: cognito.UserPoolIdentityProviderGoogle | undefined;
    const supportedIdps: cognito.UserPoolClientIdentityProvider[] = [];
    if (googleClientId && googleClientSecret) {
      googleIdp = new cognito.UserPoolIdentityProviderGoogle(this, 'GoogleIdp', {
        userPool,
        clientId: googleClientId,
        clientSecretValue: SecretValue.unsafePlainText(googleClientSecret),
        scopes: ['openid', 'email', 'profile'],
        attributeMapping: {
          email: cognito.ProviderAttribute.GOOGLE_EMAIL,
          givenName: cognito.ProviderAttribute.GOOGLE_GIVEN_NAME,
        },
      });
      supportedIdps.push(cognito.UserPoolClientIdentityProvider.GOOGLE);
    } else {
      supportedIdps.push(cognito.UserPoolClientIdentityProvider.COGNITO);
    }

    new cognito.UserPoolDomain(this, 'HostedUiDomain', {
      userPool,
      cognitoDomain: { domainPrefix: hostedUiPrefix },
    });

    // Both origins stay registered so the admin app works on the CloudFront
    // domain before (and after) the custom domain is switched on.
    const callbackUrls = [
      `https://${cloudFrontDomain}/login`,
      ...(domainEnabled ? [`https://${domainName}/login`] : []),
    ];

    const userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool,
      generateSecret: false, // public SPA client (PKCE)
      authFlows: { userSrp: true },
      // Stated rather than inherited. Cognito's defaults are 60 min / 60 min /
      // 30 days, and only the last of the three is one a human ever feels: it
      // decides how often signing in again is unavoidable. Leaving it implicit
      // meant the answer lived in AWS's documentation instead of here.
      accessTokenValidity: Duration.minutes(60),
      idTokenValidity: Duration.minutes(60),
      refreshTokenValidity: Duration.days(90),
      // Default is already true; pinned because a 90-day window makes signing
      // out the only thing that ends a session, so it had better end it.
      enableTokenRevocation: true,
      // Refresh token rotation is deliberately NOT enabled. It invalidates the
      // previous token after a grace period of at most 60 seconds, so two admin
      // tabs refreshing at once would race and lose the session — the exact
      // failure the client-side refresh handling exists to avoid.
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls,
        logoutUrls: callbackUrls,
      },
      supportedIdentityProviders: supportedIdps,
    });
    if (googleIdp) userPoolClient.node.addDependency(googleIdp);

    // =========================================================================
    // Multi-action Lambda (router + S3 processor)
    // =========================================================================
    const handlerFn = new NodejsFunction(this, 'HandlerFn', {
      entry: path.join(__dirname, 'lambda', 'handler.ts'),
      handler: 'handler',
      runtime: NODE_RUNTIME,
      // The processor copies one GLB server-side (CopyObject) and rewrites small
      // JSON objects, so it never holds a model in memory. 1024 MB is chosen for
      // CPU share on the JSON/crypto work, not for headroom.
      memorySize: 1024,
      timeout: Duration.minutes(2),
      environment: {
        STAGING_BUCKET: stagingBucket.bucketName,
        ASSETS_BUCKET: assetsBucket.bucketName,
        METADATA_BUCKET: metadataBucket.bucketName,
        METADATA_KEY,
        ALLOWED_EMAILS: allowedEmails,
        VIEWER_EMAILS: viewerEmails,
        DISTRIBUTION_ID: distribution.distributionId,
        SITE_URL: siteUrl,
      },
      bundling: {
        // Bundled rather than taken from the runtime: which SDK version the
        // preview runtime carries is undocumented and may change.
        bundleAwsSDK: true,
      },
    });

    // S3 event: only uploads (prefix uploads/) trigger the processor. Processor
    // output goes to a different bucket, so there is no self-trigger.
    stagingBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(handlerFn),
      { prefix: 'uploads/' },
    );

    // --- IAM grants ---------------------------------------------------------
    stagingBucket.grantReadWrite(handlerFn); // presign target + read upload
    assetsBucket.grantReadWrite(handlerFn); // models, manifests, comments, status
    metadataBucket.grantReadWrite(handlerFn); // metadata.json
    handlerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudfront:CreateInvalidation'],
        resources: [
          `arn:aws:cloudfront::${Stack.of(this).account}:distribution/${distribution.distributionId}`,
        ],
      }),
    );

    // =========================================================================
    // HTTP API — three auth models on one Lambda
    // =========================================================================
    const jwtAuthorizer = new HttpUserPoolAuthorizer('Authorizer', userPool, {
      userPoolClients: [userPoolClient],
    });
    const iamAuthorizer = new HttpIamAuthorizer();
    const integration = new HttpLambdaIntegration('HandlerIntegration', handlerFn);

    const httpApi = new apigwv2.HttpApi(this, 'Api', {
      corsPreflight: {
        // The only browser callers are the admin app and the viewer's comment
        // form, both served from the distribution.
        allowOrigins: [
          `https://${cloudFrontDomain}`,
          ...(domainEnabled ? [`https://${domainName}`] : []),
          'http://localhost:5173',
          'http://localhost:8080',
        ],
        allowMethods: [apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.OPTIONS],
        allowHeaders: ['authorization', 'content-type'],
        maxAge: Duration.hours(1),
      },
    });

    // Publishing is automation-first: SigV4 with the deployer's own AWS
    // credentials, so a Notor workflow needs no OAuth dance. Cognito stays for
    // the human admin app only.
    const publishRoutes = httpApi.addRoutes({
      path: '/publish',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: iamAuthorizer,
    });

    // Admin actions — Google sign-in + the admin allowlist (re-checked in the
    // handler, which is where a read-only account is turned away).
    const adminRoutes = ['list', 'edit', 'delete', 'feedback'].flatMap((action) =>
      httpApi.addRoutes({
        path: `/${action}`,
        methods: [apigwv2.HttpMethod.POST],
        integration,
        authorizer: jwtAuthorizer,
      }),
    );

    // Read-only: the published catalog, for accounts on either allowlist. Same
    // authorizer as the admin routes — one user pool issues both roles' tokens, so
    // the handler is what tells them apart. Kept out of `adminRoutes` because the
    // two have genuinely different authorization, not merely different paths.
    const readRoutes = httpApi.addRoutes({
      path: '/browse',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer,
    });

    // Public: anyone with a share link can leave feedback without signing in.
    // Guarded by route throttling below plus strict caps in the handler.
    const commentRoutes = httpApi.addRoutes({
      path: '/comment',
      methods: [apigwv2.HttpMethod.POST],
      integration,
    });

    const stage = httpApi.defaultStage!.node.defaultChild as apigwv2.CfnStage;
    stage.addPropertyOverride('DefaultRouteSettings', {
      ThrottlingRateLimit: 20,
      ThrottlingBurstLimit: 40,
    });
    stage.addPropertyOverride('RouteSettings', {
      'POST /comment': { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
    });
    // API Gateway validates each RouteSettings key against the API's existing
    // routes, and nothing in the template otherwise orders the stage after the
    // routes — CloudFormation creates them in parallel and the stage loses the
    // race ("Unable to find Route by key POST /comment"). Only the keyed route
    // needs to exist first, but depending on all of them is cheap and keeps this
    // correct if another route is given settings later.
    for (const route of [...publishRoutes, ...adminRoutes, ...readRoutes, ...commentRoutes]) {
      stage.node.addDependency(route);
    }

    const apiUrl = httpApi.apiEndpoint;

    // =========================================================================
    // Deploy the two SPAs + their synthesized config.json
    // =========================================================================
    // prune is off so a deployment never touches runtime content (models,
    // manifests, comments) that lives in the same bucket.
    new s3deploy.BucketDeployment(this, 'DeployAdminApp', {
      destinationBucket: assetsBucket,
      destinationKeyPrefix: 'app',
      prune: false,
      sources: [
        s3deploy.Source.asset(path.join(__dirname, '..', 'admin-app')),
        s3deploy.Source.jsonData('config.json', {
          userPoolId: userPool.userPoolId,
          userPoolClientId: userPoolClient.userPoolClientId,
          hostedUiDomain,
          apiUrl,
          cloudFrontDomain,
          shareDomain: siteDomain,
        }),
      ],
      distribution,
      distributionPaths: ['/login', '/admin', '/browse', '/app/*'],
    });

    new s3deploy.BucketDeployment(this, 'DeployViewerApp', {
      destinationBucket: assetsBucket,
      destinationKeyPrefix: 'viewer',
      prune: false,
      sources: [
        s3deploy.Source.asset(path.join(__dirname, '..', 'viewer-app')),
        s3deploy.Source.jsonData('config.json', { apiUrl, siteUrl }),
      ],
      distribution,
      distributionPaths: ['/viewer/*'],
    });

    // =========================================================================
    // Outputs
    // =========================================================================
    new CfnOutput(this, 'SiteUrl', { value: siteUrl });
    new CfnOutput(this, 'CloudFrontDomain', { value: cloudFrontDomain });
    new CfnOutput(this, 'AdminLoginUrl', { value: `${siteUrl}/login` });
    new CfnOutput(this, 'ApiUrl', { value: apiUrl });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, 'HostedUiDomainOut', { value: hostedUiDomain });
    new CfnOutput(this, 'GoogleRedirectUri', {
      value: `https://${hostedUiDomain}/oauth2/idpresponse`,
      description: 'Set this as the authorized redirect URI in the Google OAuth client',
    });
    new CfnOutput(this, 'PublishRouteArn', {
      value: `arn:aws:execute-api:${region}:${Stack.of(this).account}:${httpApi.apiId}/*/POST/publish`,
      description: 'Scope execute-api:Invoke to this ARN for a publish-only principal',
    });
    new CfnOutput(this, 'StagingBucketName', { value: stagingBucket.bucketName });
    new CfnOutput(this, 'AssetsBucketName', { value: assetsBucket.bucketName });
    if (certificate) {
      new CfnOutput(this, 'CertificateArn', {
        value: certificate.certificateArn,
        description: 'Certificate whose validation CNAME must stay in the parent zone',
      });
    }
  }

  // ---- helpers -------------------------------------------------------------

  private ctx(key: string, fallback: string): string {
    const v = this.node.tryGetContext(key);
    return v === undefined || v === null || v === '' ? fallback : String(v);
  }

  private ctxBool(key: string, fallback: boolean): boolean {
    const v = this.node.tryGetContext(key);
    if (v === undefined || v === null || v === '') return fallback;
    if (typeof v === 'boolean') return v;
    return String(v).toLowerCase() === 'true';
  }

  private liveBehavior(
    origin: cloudfront.IOrigin,
    cachePolicy: cloudfront.ICachePolicy,
  ): cloudfront.BehaviorOptions {
    return {
      origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy,
    };
  }

  private adminBehavior(
    origin: cloudfront.IOrigin,
    cachePolicy: cloudfront.ICachePolicy,
    functionAssociations: cloudfront.FunctionAssociation[],
  ): cloudfront.BehaviorOptions {
    return {
      origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy,
      functionAssociations,
    };
  }
}
