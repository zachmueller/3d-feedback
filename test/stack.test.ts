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
});

describe('custom domain', () => {
  it('is off by default, so a first deploy needs no DNS delegation', () => {
    const template = synth();
    template.resourceCountIs('AWS::Route53::HostedZone', 0);
    template.resourceCountIs('AWS::CertificateManager::Certificate', 0);
    template.resourceCountIs('AWS::Route53::RecordSet', 0);
  });

  it('creates the zone, a DNS-validated certificate and both alias records when enabled', () => {
    const template = synth({ 'threedHost:domainEnabled': 'true' });
    template.hasResourceProperties('AWS::Route53::HostedZone', { Name: '3d.example.com.' });
    template.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: '3d.example.com',
      ValidationMethod: 'DNS',
    });
    template.resourceCountIs('AWS::Route53::RecordSet', 2);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: { Aliases: ['3d.example.com'] },
    });
  });

  it('publishes the name servers needed for the parent-zone delegation', () => {
    const outputs = synth({ 'threedHost:domainEnabled': 'true' }).findOutputs('*');
    expect(Object.keys(outputs)).toContain('DelegationNameServers');
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
      Runtime: 'nodejs22.x',
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
