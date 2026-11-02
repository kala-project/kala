using System.Text.RegularExpressions;

var builder = DistributedApplication.CreateBuilder(args);

// Aspire's Docker publishing integration turns this application model into
// docker-compose.yaml. Deployment remains an operator/CI responsibility.
// Production Compose must not expose the Aspire diagnostic dashboard.
builder.AddDockerComposeEnvironment("compose").WithDashboard(enabled: false);

var publicHostname = Required("KALA_PUBLIC_HOSTNAME");
var publicOrigin = Required("KALA_PUBLIC_ORIGIN");
var publicPort = PositivePort("KALA_PUBLIC_PORT", 443);
var runtimeLlmModel = Required("KALA_RUNTIME_LLM_MODEL");
var runtimeLlmBaseUrl = Required("KALA_RUNTIME_LLM_BASE_URL");

var edgeImage = RequiredDigestImage("KALA_EDGE_IMAGE");
var gatewayImage = RequiredDigestImage("KALA_GATEWAY_IMAGE");
var runtimeImage = RequiredDigestImage("KALA_RUNTIME_IMAGE");
var dashboardImage = RequiredDigestImage("KALA_DASHBOARD_IMAGE");
var postgresImage = RequiredDigestImage("KALA_POSTGRES_IMAGE");
var siloImage = RequiredDigestImage("KALA_SILO_IMAGE");

// Bind mounts deliberately keep authoritative bytes outside the Compose
// project lifecycle. The outside deployer must create, permission, back up,
// and restore these two absolute host directories.
var postgresDataDirectory = RequiredAbsoluteDirectory("KALA_POSTGRES_DATA_DIR");
var siloDataDirectory = RequiredAbsoluteDirectory("KALA_SILO_DATA_DIR");
var stateMasterKeyFile = RequiredAbsoluteFile("KALA_RUNTIME_STATE_MASTER_KEY_FILE");
var installationIdFile = RequiredAbsoluteFile("KALA_INSTALLATION_ID_FILE");

var postgresPassword = builder.AddParameter("postgres-password", secret: true);
var gatewayDatabaseUrl = builder.AddParameter("gateway-database-url", secret: true);
var runtimeDatabaseUrl = builder.AddParameter("runtime-database-url", secret: true);
var runtimeReaderDatabaseUrl = builder.AddParameter("runtime-reader-database-url", secret: true);
var ingressSharedSecret = builder.AddParameter("ingress-shared-secret", secret: true);
var gatewaySessionSecret = builder.AddParameter("gateway-session-secret", secret: true);
var siloRootAccessKey = builder.AddParameter("silo-root-access-key", secret: true);
var siloRootSecretKey = builder.AddParameter("silo-root-secret-key", secret: true);
// A future provisioning job must issue bucket-scoped credentials; never give
// SILO administrator credentials to the application Runtime.
var runtimeS3AccessKey = builder.AddParameter("runtime-s3-access-key", secret: true);
var runtimeS3SecretKey = builder.AddParameter("runtime-s3-secret-key", secret: true);
var llmApiKey = builder.AddParameter("llm-api-key", secret: true);

// Bootstrap only the PostgreSQL maintenance database and superuser. The
// operator initialization flow creates independent control/Runtime databases
// and owner, writer, and reader principals before any application starts.
var postgres = builder.AddContainer("postgres", postgresImage)
    .WithEnvironment("POSTGRES_DB", "postgres")
    .WithEnvironment("POSTGRES_USER", "postgres")
    .WithEnvironment("POSTGRES_PASSWORD", postgresPassword)
    .WithBindMount(postgresDataDirectory, "/var/lib/postgresql/data")
    .WithImagePullPolicy(ImagePullPolicy.Missing);

var silo = builder.AddContainer("silo", siloImage)
    .WithArgs("server", "/data", "--console-address", ":9001")
    .WithEnvironment("MINIO_ROOT_USER", siloRootAccessKey)
    .WithEnvironment("MINIO_ROOT_PASSWORD", siloRootSecretKey)
    .WithBindMount(siloDataDirectory, "/data")
    .WithImagePullPolicy(ImagePullPolicy.Missing);

var dashboard = builder.AddContainer("dashboard", dashboardImage)
    .WithImagePullPolicy(ImagePullPolicy.Missing);

var runtime = builder.AddContainer("runtime", runtimeImage)
    .WithEnvironment("KALA_DEPLOYMENT_CONFIG", "/etc/kala/deployment.json")
    // Container-writable scratch inside the unprivileged Host package; PG/S3 remain the authorities.
    .WithEnvironment("KALA_RUNTIME_HOST_DATA_ROOT", "/app/packages/host/.runtime-tmp/kala")
    .WithEnvironment("KALA_RUNTIME_AUTHORITY_ORIGIN", "http://gateway:13001")
    .WithEnvironment("TMPDIR", "/app/packages/host/.runtime-tmp")
    .WithEnvironment("KALA_RUNTIME_HOST_RELEASE_ASSETS_DIR", "/app/release")
    .WithEnvironment("KALA_RUNTIME_KALA_PORT", "13002")
    .WithEnvironment("KALA_RUNTIME_KALA_BIND_HOST", "0.0.0.0")
    .WithEnvironment("KALA_RUNTIME_NODE_ID", "runtime")
    .WithEnvironment("KALA_RUNTIME_NODE_ORIGIN", "http://runtime:13002")
    .WithEnvironment("KALA_INGRESS_SHARED_SECRET", ingressSharedSecret)
    .WithEnvironment("KALA_RUNTIME_HOST_LLM_API_KEY", llmApiKey)
    .WithEnvironment("KALA_RUNTIME_HOST_LLM_MODEL", runtimeLlmModel)
    .WithEnvironment("KALA_RUNTIME_HOST_LLM_BASE_URL", runtimeLlmBaseUrl)
    .WithEnvironment("KALA_RUNTIME_EXPERIMENTAL_DOCKER_STORAGE", "1")
    .WithEnvironment("KALA_RUNTIME_POSTGRES_SCHEMA_MODE", "versioned")
    .WithEnvironment("KALA_RUNTIME_EXPERIMENTAL_SESSION_OWNERSHIP", "1")
    .WithEnvironment("KALA_RUNTIME_EXPERIMENTAL_POSTGRES_CONNECTION_STRING", runtimeDatabaseUrl)
    .WithEnvironment("KALA_RUNTIME_EXPERIMENTAL_S3_ENDPOINT", "http://silo:9000")
    .WithEnvironment("KALA_RUNTIME_EXPERIMENTAL_S3_REGION", "us-east-1")
    .WithEnvironment("KALA_RUNTIME_EXPERIMENTAL_S3_BUCKET", "kala-runtime")
    .WithEnvironment("KALA_RUNTIME_EXPERIMENTAL_S3_MAX_OBJECT_BYTES", "104857600")
    .WithEnvironment("KALA_RUNTIME_REQUIRE_INSTALLATION_CLAIM", "1")
    .WithEnvironment("KALA_INSTALLATION_ID_FILE", "/run/kala-secrets/installation-id")
    .WithEnvironment("KALA_RUNTIME_EXPERIMENTAL_S3_ACCESS_KEY_ID", runtimeS3AccessKey)
    .WithEnvironment("KALA_RUNTIME_EXPERIMENTAL_S3_SECRET_ACCESS_KEY", runtimeS3SecretKey)
    .WithEnvironment("KALA_RUNTIME_EXPERIMENTAL_S3_FORCE_PATH_STYLE", "true")
    .WithEnvironment("KALA_RUNTIME_EXPERIMENTAL_STATE_MASTER_KEY_FILE", "/run/kala-secrets/runtime-state-master-key")
    .WithBindMount(Path.Combine(builder.AppHostDirectory, "deployment.json"), "/etc/kala/deployment.json", isReadOnly: true)
    .WithBindMount(stateMasterKeyFile, "/run/kala-secrets/runtime-state-master-key", isReadOnly: true)
    .WithBindMount(installationIdFile, "/run/kala-secrets/installation-id", isReadOnly: true)
    .WaitFor(postgres)
    .WaitFor(silo)
    .WithImagePullPolicy(ImagePullPolicy.Missing);

var gateway = builder.AddContainer("gateway", gatewayImage)
    .WithEnvironment("KALA_DEPLOYMENT_CONFIG", "/etc/kala/deployment.json")
    .WithEnvironment("KALA_INGRESS_PORT", "13001")
    .WithEnvironment("KALA_INGRESS_LISTEN_HOST", "0.0.0.0")
    .WithEnvironment("KALA_PUBLIC_URLS", publicOrigin)
    .WithEnvironment("KALA_RUNTIME_HOST_ORIGIN", "http://runtime:13002")
    .WithEnvironment("KALA_INGRESS_DASHBOARD_ORIGIN", "http://dashboard:8080")
    .WithEnvironment("KALA_INGRESS_DATABASE_URL", gatewayDatabaseUrl)
    .WithEnvironment("KALA_INGRESS_MIGRATIONS_DIR", "/app/packages/runtime-ingress-gateway/migrations")
    .WithEnvironment("KALA_INGRESS_EXPERIMENTAL_DOCKER_STORAGE", "1")
    .WithEnvironment("KALA_INGRESS_EXPERIMENTAL_POSTGRES_READER_CONNECTION_STRING", runtimeReaderDatabaseUrl)
    .WithEnvironment("KALA_INGRESS_EXPERIMENTAL_RUNTIME_ORIGIN_ALLOWLIST", "http://runtime:13002")
    .WithEnvironment("KALA_INGRESS_EXPERIMENTAL_BOOTSTRAP_RUNTIME_ORIGIN", "http://runtime:13002")
    .WithEnvironment("KALA_INGRESS_REQUIRE_INSTALLATION_CLAIM", "1")
    .WithEnvironment("KALA_INSTALLATION_ID_FILE", "/run/kala-secrets/installation-id")
    .WithEnvironment("KALA_INGRESS_SESSION_SECRET", gatewaySessionSecret)
    .WithEnvironment("KALA_INGRESS_SHARED_SECRET", ingressSharedSecret)
    .WithBindMount(Path.Combine(builder.AppHostDirectory, "deployment.json"), "/etc/kala/deployment.json", isReadOnly: true)
    .WithBindMount(installationIdFile, "/run/kala-secrets/installation-id", isReadOnly: true)
    .WaitFor(runtime)
    .WaitFor(dashboard)
    .WithImagePullPolicy(ImagePullPolicy.Missing);

// Caddy is the only resource with a host-published endpoint. Gateway,
// Runtime, Dashboard, PostgreSQL, and SILO stay on the Compose network.
builder.AddContainer("ingress", edgeImage)
    .WithEnvironment("KALA_PUBLIC_HOSTNAME", publicHostname)
    .WithBindMount(Path.Combine(builder.AppHostDirectory, "Caddyfile"), "/etc/caddy/Caddyfile", isReadOnly: true)
    .WithVolume("kala-aspire-caddy-data", "/data")
    .WithVolume("kala-aspire-caddy-config", "/config")
    .WithEndpoint(port: publicPort, targetPort: 443, name: "https", scheme: "https", isProxied: false)
    .WithExternalHttpEndpoints()
    .WaitFor(gateway)
    .WithImagePullPolicy(ImagePullPolicy.Missing);

builder.Build().Run();

static string Required(string name)
{
    var value = Environment.GetEnvironmentVariable(name)?.Trim();
    return !string.IsNullOrEmpty(value)
        ? value
        : throw new InvalidOperationException($"{name} must be set before running or publishing the AppHost.");
}

static string RequiredDigestImage(string name)
{
    var value = Required(name);
    return Regex.IsMatch(value, @"^[^\s]+@sha256:[0-9a-fA-F]{64}$", RegexOptions.CultureInvariant)
        ? value
        : throw new InvalidOperationException($"{name} must be an immutable image reference ending in @sha256:<64 hex digits>.");
}

static string RequiredAbsoluteDirectory(string name)
{
    var value = Required(name);
    if (!Path.IsPathFullyQualified(value))
        throw new InvalidOperationException($"{name} must be an absolute host path.");
    return value;
}

static string RequiredAbsoluteFile(string name)
{
    var value = RequiredAbsoluteDirectory(name);
    return File.Exists(value)
        ? value
        : throw new InvalidOperationException($"{name} must name an existing host file before publishing.");
}

static int PositivePort(string name, int fallback)
{
    var value = Environment.GetEnvironmentVariable(name)?.Trim();
    if (string.IsNullOrEmpty(value)) return fallback;
    return int.TryParse(value, out var port) && port is > 0 and <= 65535
        ? port
        : throw new InvalidOperationException($"{name} must be an integer from 1 through 65535.");
}
