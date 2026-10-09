/**
 * Template assertions for the single stack. These guard the wiring that is easy
 * to break and expensive to discover after a deploy: which paths are cached for
 * how long, which API routes are authorized how, and whether the custom domain
 * is opt-in.
 */
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ThreedHostStack } from '../lib/threed-host-stack';

const ENV = { account: '123456789012', region: 'us-east-1' };

function synth(context: Record<string, string> = {}) {
  const app = new cdk.App({
    context: {
      'threedHost:allowedEmails': 'me@example.com',
      'threedHost:domainName': '3d.example.com',
      ...context,
    },
  });
  const stack = new ThreedHostStack(app, 'TestStack', { env: ENV });
  return Template.fromStack(stack);
}

describe('storage', () => {
  const template = synth();

  it('creates three buckets, all closed to the public', () => {
    template.resourceCountIs('AWS::S3::Bucket', 3);
    const buckets = template.findResources('AWS::S3::Bucket');
    for (const bucket of Object.values(buckets)) {
      expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
    }
  });

  it('expires raw uploads so staging does not accumulate models', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([Match.objectLike({ ExpirationInDays: 30, Status: 'Enabled' })]),
      },
    });
  });
});

describe('CloudFront caching', () => {
  const template = synth();

  /** Find a cache policy by its TTL triple. */
  function policyWithTtls(defaultTtl: number, minTtl: number, maxTtl: number) {
    const policies = template.findResources('AWS::CloudFront::CachePolicy');
    return Object.values(policies).filter((p) => {
      const c = p.Properties.CachePolicyConfig;
      return c.DefaultTTL === defaultTtl && c.MinTTL === minTtl && c.MaxTTL === maxTtl;
    });
  }

  it('has an immutable policy for model content', () => {
    const year = 31536000;
    expect(policyWithTtls(year, year, year)).toHaveLength(1);
  });

  it('has a near-live policy for manifests, comments and status', () => {
    expect(policyWithTtls(5, 0, 10)).toHaveLength(1);
  });

  // CloudFront picks a behavior from the *incoming* URI, before the
  // viewer-request function rewrites /<project>/<rev> to the viewer HTML. If the
  // default behavior carried the immutable policy, every share URL would be
  // frozen for a year and a viewer fix would never reach anyone.
  it('serves the default behavior from the short-lived policy, not the immutable one', () => {
    const distribution = Object.values(
      template.findResources('AWS::CloudFront::Distribution'),
    )[0].Properties.DistributionConfig;

    const shortCache = Object.entries(template.findResources('AWS::CloudFront::CachePolicy'))
      .find(([, p]) => p.Properties.CachePolicyConfig.DefaultTTL === 60)?.[0];
    expect(shortCache).toBeDefined();
    expect(distribution.DefaultCacheBehavior.CachePolicyId).toEqual({ Ref: shortCache });
  });

  it('long-caches only the models, via their own behavior', () => {
    const distribution = Object.values(
      template.findResources('AWS::CloudFront::Distribution'),
    )[0].Properties.DistributionConfig;

    const immutable = Object.entries(template.findResources('AWS::CloudFront::CachePolicy'))
      .find(([, p]) => p.Properties.CachePolicyConfig.DefaultTTL === 31536000)?.[0];

    const usingImmutable = (distribution.CacheBehaviors ?? []).filter(
      (b: any) => b.CachePolicyId?.Ref === immutable,
    );
    expect(usingImmutable).toHaveLength(1);
    expect(usingImmutable[0].PathPattern).toBe('*.glb');
  });

  it('routes every data and app path through its own behavior', () => {
    const distribution = Object.values(
      template.findResources('AWS::CloudFront::Distribution'),
    )[0].Properties.DistributionConfig;
    const patterns = (distribution.CacheBehaviors ?? []).map((b: any) => b.PathPattern);
    expect(patterns).toEqual(
      expect.arrayContaining([
        '*.glb',
        '/projects/*',
        '/comments/*',
        '/status/*',
        '/viewer/*',
        '/app/*',
        '/login',
        '/admin',
        '/browse',
      ]),
    );
  });

  it('turns a missing object into the viewer 404 page', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({
            ErrorCode: 403,
            ResponseCode: 404,
            ResponsePagePath: '/viewer/404.html',
          }),
        ]),
      },
    });
  });

  it('attaches the two viewer-request functions', () => {
    template.resourceCountIs('AWS::CloudFront::Function', 2);
  });
});

describe('HTTP API authorization', () => {
  const template = synth();

  /** Route resources keyed by their RouteKey, e.g. 'POST /publish'. */
  function routes() {
    const out: Record<string, any> = {};
    for (const route of Object.values(template.findResources('AWS::ApiGatewayV2::Route'))) {
      out[route.Properties.RouteKey] = route.Properties;
    }
    return out;
  }

  it('signs publishing with IAM so automation needs no OAuth dance', () => {
    expect(routes()['POST /publish'].AuthorizationType).toBe('AWS_IAM');
  });

  it('gates every admin action behind the Cognito JWT authorizer', () => {
    const all = routes();
    for (const action of ['list', 'edit', 'delete', 'feedback']) {
      const route = all[`POST /${action}`];
      expect(route.AuthorizationType).toBe('JWT');
      expect(route.AuthorizerId).toBeDefined();
    }
  });

  // The read-only catalog shares the authorizer with the admin routes, because one
  // user pool issues both roles' tokens — so the template can only show that a
  // token is required here. Which *role* that token has to have is the handler's
  // job, asserted in test/handler.test.ts.
  it('requires a token for the read-only catalog too', () => {
    const route = routes()['POST /browse'];
    expect(route.AuthorizationType).toBe('JWT');
    expect(route.AuthorizerId).toBeDefined();
  });

  it('uses one authorizer for every signed-in route', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 1);
  });

  // Reviewers comment without signing in, so this one route is deliberately
  // open; the guardrails are the throttle below plus caps in the handler.
  it('leaves the comment route unauthenticated but throttled', () => {
    const route = routes()['POST /comment'];
    expect(route.AuthorizationType ?? 'NONE').toBe('NONE');

    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      RouteSettings: {
        'POST /comment': { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
      },
      DefaultRouteSettings: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 },
    });
  });

  // API Gateway rejects RouteSettings naming a route that does not exist yet, so
  // the stage has to be ordered after the routes rather than created alongside
  // them. Losing this DependsOn only shows up as a failed deploy.
  it('creates the stage after the routes its settings name', () => {
    const stages = template.findResources('AWS::ApiGatewayV2::Stage');
    const [stage] = Object.values(stages);
    const routeIds = Object.keys(template.findResources('AWS::ApiGatewayV2::Route'));

    expect(routeIds.length).toBeGreaterThan(0);
    expect(stage.DependsOn ?? []).toEqual(expect.arrayContaining(routeIds));
  });

  it('points every route at the one handler', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::Integration', 1);
  });
});

describe('Cognito', () => {
  it('blocks self sign-up and screens sign-ins with the allowlist trigger', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      LambdaConfig: { PreSignUp: Match.anyValue() },
    });
  });

  // Both roles sign in through the same pool, so both lists have to reach both
  // Lambdas: the trigger decides who gets an account, the handler decides what the
  // account can do. A missing VIEWER_EMAILS on the trigger would reject every
  // read-only sign-in at Google; a missing one on the handler would 403 every
  // reader on /browse.
  it('gives both Lambdas both allowlists', () => {
    const template = synth({ 'threedHost:viewerEmails': 'reader@example.com' });
    const functions = Object.values(template.findResources('AWS::Lambda::Function')).filter(
      (fn) => fn.Properties.Environment?.Variables?.ALLOWED_EMAILS !== undefined,
    );
    expect(functions).toHaveLength(2); // the pre-signup trigger and the handler
    for (const fn of functions) {
      expect(fn.Properties.Environment.Variables).toMatchObject({
        ALLOWED_EMAILS: 'me@example.com',
        VIEWER_EMAILS: 'reader@example.com',
      });
    }
  });

  // Read-only access is opt-in: an existing deployment that sets nothing creates no
  // reader accounts, rather than inheriting some default address.
  it('creates no read-only accounts by default', () => {
    const template = synth();
    for (const fn of Object.values(template.findResources('AWS::Lambda::Function'))) {
      const vars = fn.Properties.Environment?.Variables ?? {};
      if (vars.VIEWER_EMAILS !== undefined) expect(vars.VIEWER_EMAILS).toBe('');
    }
  });

  // Without credentials the Google IdP is skipped so that synth and these tests
  // run with no secrets present.
  it('omits the Google provider until credentials are supplied', () => {
    synth().resourceCountIs('AWS::Cognito::UserPoolIdentityProvider', 0);
  });

  it('wires Google when credentials are supplied', () => {
    const template = synth({
      'threedHost:googleClientId': 'client-id.apps.googleusercontent.com',
      'threedHost:googleClientSecret': 'secret',
    });
    template.hasResourceProperties('AWS::Cognito::UserPoolIdentityProvider', {
      ProviderName: 'Google',
      ProviderType: 'Google',
    });
  });

  // These used to be absent, which silently meant Cognito's defaults — and the
  // 30-day refresh window among them was the difference between signing in twice
  // a year and signing in monthly. Losing them again would not fail a deploy or
  // show up in a diff of behaviour, only in how often a human sees Google.
  // 129600 minutes is 90 days; CDK normalizes every duration here to minutes.
  it('pins the token lifetimes instead of inheriting AWS defaults', () => {
    synth().hasResourceProperties('AWS::Cognito::UserPoolClient', {
      AccessTokenValidity: 60,
      IdTokenValidity: 60,
      RefreshTokenValidity: 129600,
      TokenValidityUnits: {
        AccessToken: 'minutes',
        IdToken: 'minutes',
        RefreshToken: 'minutes',
      },
      // A 90-day window makes signing out the only thing that ends a session.
      EnableTokenRevocation: true,
    });
  });

  // Rotation invalidates the previous refresh token after a grace period of at
  // most 60 seconds, so two admin tabs refreshing at once would race and lose the
  // session — the exact failure the client-side refresh handling exists to avoid.
  it('leaves refresh token rotation off', () => {
    const clients = synth().findResources('AWS::Cognito::UserPoolClient');
    for (const client of Object.values(clients)) {
      expect(client.Properties.RefreshTokenRotation).toBeUndefined();
    }
  });
});

describe('custom domain', () => {
  it('is off by default, so a first deploy needs no DNS at all', () => {
    const template = synth();
    template.resourceCountIs('AWS::CertificateManager::Certificate', 0);
    template.resourceCountIs('AWS::Route53::HostedZone', 0);
    template.resourceCountIs('AWS::Route53::RecordSet', 0);
  });

  it('creates a DNS-validated certificate and the distribution alias when enabled', () => {
    const template = synth({ 'threedHost:domainEnabled': 'true' });
    template.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: '3d.example.com',
      ValidationMethod: 'DNS',
    });
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: { Aliases: ['3d.example.com'] },
    });
  });

  // The records live in the parent zone, in another account, where neither
  // CloudFormation nor ACM's automatic validation can reach them — they are
  // written by tools/parent-dns.sh. Naming a hosted zone here would put the
  // stack back in the business of owning a second zone.
  it('owns no zone and no records, whether the domain is on or off', () => {
    for (const template of [synth(), synth({ 'threedHost:domainEnabled': 'true' })]) {
      template.resourceCountIs('AWS::Route53::HostedZone', 0);
      template.resourceCountIs('AWS::Route53::RecordSet', 0);
    }
    synth({ 'threedHost:domainEnabled': 'true' }).hasResourceProperties(
      'AWS::CertificateManager::Certificate',
      { DomainValidationOptions: Match.absent() },
    );
  });

  it('publishes the certificate whose validation record the parent zone must keep', () => {
    const outputs = Object.keys(synth({ 'threedHost:domainEnabled': 'true' }).findOutputs('*'));
    expect(outputs).toContain('CertificateArn');
    expect(outputs).not.toContain('HostedZoneId');
    expect(outputs).not.toContain('DelegationNameServers');
  });
});

describe('handler wiring', () => {
  const template = synth();

  it('processes uploads from the staging prefix only', () => {
    template.hasResourceProperties('Custom::S3BucketNotifications', {
      NotificationConfiguration: {
        LambdaFunctionConfigurations: Match.arrayWith([
          Match.objectLike({
            Filter: {
              Key: { FilterRules: [{ Name: 'prefix', Value: 'uploads/' }] },
            },
          }),
        ]),
      },
    });
  });

  it('runs on a supported runtime and knows where everything lives', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs26.x',
      Environment: {
        Variables: Match.objectLike({
          ASSETS_BUCKET: Match.anyValue(),
          STAGING_BUCKET: Match.anyValue(),
          METADATA_BUCKET: Match.anyValue(),
          METADATA_KEY: 'metadata.json',
          DISTRIBUTION_ID: Match.anyValue(),
          SITE_URL: Match.anyValue(),
        }),
      },
    });
  });

  // Correctness comes from conditional writes on metadata.json, not from
  // serializing invocations — a new account cannot even reserve concurrency.
  it('does not rely on reserved concurrency', () => {
    for (const fn of Object.values(template.findResources('AWS::Lambda::Function'))) {
      expect(fn.Properties.ReservedConcurrentExecutions).toBeUndefined();
    }
  });

  it('can invalidate only its own distribution', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'cloudfront:CreateInvalidation',
            Effect: 'Allow',
            Resource: Match.anyValue(),
          }),
        ]),
      },
    });
  });
});

describe('app deployments', () => {
  const template = synth();

  it('ships both SPAs without pruning runtime content', () => {
    const deployments = Object.values(
      template.findResources('Custom::CDKBucketDeployment'),
    );
    expect(deployments).toHaveLength(2);
    for (const deployment of deployments) {
      // Models, manifests and comment threads live in the same bucket as the
      // apps; pruning would delete them on every deploy.
      expect(deployment.Properties.Prune).toBe(false);
    }
    const prefixes = deployments.map((d) => d.Properties.DestinationBucketKeyPrefix);
    expect(prefixes).toEqual(expect.arrayContaining(['app', 'viewer']));
  });
});
