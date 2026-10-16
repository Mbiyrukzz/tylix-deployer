/**
 * Minimal AWS EC2 client for the deployer, built on @aws-sdk/client-ec2.
 *
 * Differences the job must respect:
 *   - Credentials are an access key pair, stored as JSON in providers.credentials:
 *       { "access_key_id": "AKIA...", "secret_access_key": "..." }
 *   - EC2 is regional, so every machine reference is "<region>/<instance-id>"
 *     (for example "us-east-1/i-0abc123"). Nothing else tells get() or remove()
 *     which region to talk to.
 *   - Images are logical ids ("ubuntu-24.04"). The AMI differs per region, so it
 *     is resolved from Canonical's published images when the machine is created.
 *   - We log in as root with the deploy key injected through cloud-init. Ubuntu
 *     AMIs disable root by default, hence disable_root: false.
 *   - A security group "tylix-deploy" (all inbound open, like the other providers)
 *     is created in the region's default VPC. The server's ufw is the real firewall.
 *   - The catalog is a curated list of instance types, filtered to the region.
 *     Prices are not looked up (monthly = 0).
 *   - Errors never include the credentials: AWS does not echo them.
 */

import {
    EC2Client,
    AuthorizeSecurityGroupIngressCommand,
    CreateSecurityGroupCommand,
    DescribeImagesCommand,
    DescribeInstanceTypeOfferingsCommand,
    DescribeInstanceTypesCommand,
    DescribeInstancesCommand,
    DescribeRegionsCommand,
    DescribeSecurityGroupsCommand,
    DescribeVpcsCommand,
    RunInstancesCommand,
    TerminateInstancesCommand,
    type DescribeInstanceTypesCommandInput,
    type Instance,
    type RunInstancesCommandInput,
} from "@aws-sdk/client-ec2";

/** Account-wide calls (verify, region list) go through this region. */
const DEFAULT_REGION = "us-east-1";
const TIMEOUT_MS = 20_000;
const CONNECT_TIMEOUT_MS = 10_000;

/** Root volume size we create. The Ubuntu default of 8 GB is too small for the Tylix template. */
const ROOT_VOLUME_GB = 30;

const CANONICAL_OWNER = "099720109477";
const SECURITY_GROUP_NAME = "tylix-deploy";

/** The only instance types offered. Add a type here and it shows up wherever the region has it. */
const CURATED_TYPES = [
    "t3.small", "t3.medium", "t3.large", "t3.xlarge", "t3.2xlarge",
    "m6i.large", "m6i.xlarge", "m6i.2xlarge",
    "c6i.large", "c6i.xlarge", "c6i.2xlarge",
];

const FAMILY_CLASS: Record<string, string> = {
    t3: "burstable",
    m6i: "general",
    c6i: "compute",
};

/** Logical image id -> label and the AMI name pattern Canonical publishes it under. */
const IMAGES = [
    {
        id: "ubuntu-24.04",
        label: "Ubuntu 24.04",
        pattern: "ubuntu/images/hvm-ssd*/ubuntu-noble-24.04-amd64-server-*",
    },
    {
        id: "ubuntu-22.04",
        label: "Ubuntu 22.04",
        pattern: "ubuntu/images/hvm-ssd*/ubuntu-jammy-22.04-amd64-server-*",
    },
];

/** [city, country] for readable region labels. Unknown regions fall back to their id. */
const REGION_NAMES: Record<string, [string, string]> = {
    "us-east-1": ["N. Virginia", "US"],
    "us-east-2": ["Ohio", "US"],
    "us-west-1": ["N. California", "US"],
    "us-west-2": ["Oregon", "US"],
    "af-south-1": ["Cape Town", "ZA"],
    "ap-east-1": ["Hong Kong", "HK"],
    "ap-south-1": ["Mumbai", "IN"],
    "ap-south-2": ["Hyderabad", "IN"],
    "ap-southeast-1": ["Singapore", "SG"],
    "ap-southeast-2": ["Sydney", "AU"],
    "ap-southeast-3": ["Jakarta", "ID"],
    "ap-southeast-4": ["Melbourne", "AU"],
    "ap-northeast-1": ["Tokyo", "JP"],
    "ap-northeast-2": ["Seoul", "KR"],
    "ap-northeast-3": ["Osaka", "JP"],
    "ca-central-1": ["Canada Central", "CA"],
    "eu-central-1": ["Frankfurt", "DE"],
    "eu-central-2": ["Zurich", "CH"],
    "eu-west-1": ["Ireland", "IE"],
    "eu-west-2": ["London", "GB"],
    "eu-west-3": ["Paris", "FR"],
    "eu-south-1": ["Milan", "IT"],
    "eu-south-2": ["Spain", "ES"],
    "eu-north-1": ["Stockholm", "SE"],
    "il-central-1": ["Tel Aviv", "IL"],
    "me-south-1": ["Bahrain", "BH"],
    "me-central-1": ["UAE", "AE"],
    "sa-east-1": ["Sao Paulo", "BR"],
};

export interface AwsCredentials {
    accessKeyId: string;
    secretAccessKey: string;
}

export interface AwsRegion { id: string; label: string; country: string }
export interface AwsPlan {
    id: string; label: string; class: string; memory_mb: number; vcpus: number;
    disk_gb: number; monthly: number; hourly: number; currency: "USD";
}
export interface AwsImage { id: string; label: string }

export interface AwsInstance {
    /** "<region>/<instance-id>" */
    ref: string;
    /** pending, running, stopping, stopped, shutting-down, terminated */
    state: string;
    /** Public IPv4, or "" until AWS assigns one. */
    ip: string;
}

export interface CreateAwsInstanceInput {
    provisionId: number;
    region: string;
    type: string;
    image: string;
    name: string;
    authorizedKeys: string[];
}

const AUTH_CODES = new Set([
    "AuthFailure",
    "UnauthorizedOperation",
    "InvalidClientTokenId",
    "SignatureDoesNotMatch",
    "UnrecognizedClientException",
    "AccessDenied",
    "AccessDeniedException",
    "ExpiredToken",
    "OptInRequired",
]);

/** Worth retrying while polling. InvalidInstanceID.NotFound: a new instance is not visible for a few seconds. */
const TRANSIENT_CODES = new Set([
    "RequestLimitExceeded",
    "Throttling",
    "ThrottlingException",
    "RequestThrottled",
    "InternalError",
    "InternalFailure",
    "ServiceUnavailable",
    "Unavailable",
    "InvalidInstanceID.NotFound",
]);

export class AwsError extends Error {
    status: number;
    code: string;

    constructor(message: string, status: number, code = "") {
        super(message);
        this.name = "AwsError";
        this.status = status;
        this.code = code;
    }

    /** Bad key, revoked key, or missing IAM permission. */
    get isAuth(): boolean {
        return this.status === 401 || this.status === 403 || AUTH_CODES.has(this.code);
    }

    /** Network failure, 5xx or rate limit. */
    get isTransient(): boolean {
        return this.status === 0 || this.status >= 500 || TRANSIENT_CODES.has(this.code);
    }
}

function wrap(error: unknown): AwsError {
    if (error instanceof AwsError) return error;

    const err = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } } | null;
    const status = err?.$metadata?.httpStatusCode ?? 0;
    const code = err?.name ?? "";

    if (status === 0) {
        return new AwsError(`Could not reach AWS (${code || "network error"}).`, 0, code);
    }
    return new AwsError(err?.message || `AWS API error (${status})`, status, code);
}

/** Reads the JSON stored in providers.credentials. Throws if it is incomplete. */
export function parseAwsCredentials(secret: string): AwsCredentials {
    let data: { access_key_id?: unknown; secret_access_key?: unknown } | null = null;
    try {
        data = JSON.parse(secret);
    } catch {
        /* handled below */
    }

    const accessKeyId = typeof data?.access_key_id === "string" ? data.access_key_id.trim() : "";
    const secretAccessKey = typeof data?.secret_access_key === "string" ? data.secret_access_key.trim() : "";

    if (!accessKeyId || !secretAccessKey) {
        throw new Error("The stored AWS credentials are incomplete.");
    }
    return { accessKeyId, secretAccessKey };
}

export function makeRef(region: string, instanceId: string): string {
    return `${region}/${instanceId}`;
}

export function splitRef(ref: string): { region: string; id: string } {
    const i = ref.indexOf("/");
    if (i <= 0 || i === ref.length - 1) {
        throw new AwsError("That isn't a valid AWS machine reference.", 400, "BadReference");
    }
    return { region: ref.slice(0, i), id: ref.slice(i + 1) };
}

function buildUserData(keys: string[]): string {
    const lines = ["#cloud-config", "disable_root: false", "ssh_pwauth: false", "ssh_authorized_keys:"];
    for (const key of keys) lines.push(`  - ${JSON.stringify(key.trim())}`);
    return Buffer.from(lines.join("\n") + "\n", "utf8").toString("base64");
}

function toInstance(region: string, raw: Instance): AwsInstance {
    return {
        ref: makeRef(region, raw.InstanceId ?? ""),
        state: raw.State?.Name ?? "",
        ip: raw.PublicIpAddress ?? "",
    };
}

export class AwsClient {
    private creds: AwsCredentials;
    private clients = new Map<string, EC2Client>();

    constructor(creds: AwsCredentials) {
        this.creds = creds;
    }

    /** One EC2 client per region, created on first use. */
    private ec2(region: string): EC2Client {
        let client = this.clients.get(region);
        if (!client) {
            client = new EC2Client({
                region,
                credentials: this.creds,
                maxAttempts: 3,
                requestHandler: { requestTimeout: TIMEOUT_MS, connectionTimeout: CONNECT_TIMEOUT_MS },
            });
            this.clients.set(region, client);
        }
        return client;
    }

    private async send<T>(region: string, run: (client: EC2Client) => Promise<T>): Promise<T> {
        try {
            return await run(this.ec2(region));
        } catch (error) {
            throw wrap(error);
        }
    }

    /** Read-only. A key that can't list regions can't do anything else here either. */
    async verify(): Promise<void> {
        await this.send(DEFAULT_REGION, (c) => c.send(new DescribeRegionsCommand({})));
    }

    // ---- Catalog ----

    async regions(): Promise<AwsRegion[]> {
        const res = await this.send(DEFAULT_REGION, (c) => c.send(new DescribeRegionsCommand({})));

        const out: AwsRegion[] = [];
        for (const r of res.Regions ?? []) {
            if (!r.RegionName) continue;
            const known = REGION_NAMES[r.RegionName];
            out.push({
                id: r.RegionName,
                label: known ? `${known[0]} (${known[1]})` : r.RegionName,
                country: known ? known[1] : "",
            });
        }
        return out.sort((a, b) => a.label.localeCompare(b.label));
    }

    images(): AwsImage[] {
        return IMAGES.map((i) => ({ id: i.id, label: i.label }));
    }

    async plans(region?: string): Promise<AwsPlan[]> {
        const where = region || DEFAULT_REGION;

        // 1. Which curated types does this region actually offer?
        const offered = new Set<string>();
        let token: string | undefined;
        do {
            const res = await this.send(where, (c) =>
                c.send(
                    new DescribeInstanceTypeOfferingsCommand({
                        LocationType: "region",
                        Filters: [{ Name: "instance-type", Values: CURATED_TYPES }],
                        NextToken: token,
                    }),
                ),
            );
            for (const o of res.InstanceTypeOfferings ?? []) {
                if (o.InstanceType) offered.add(String(o.InstanceType));
            }
            token = res.NextToken;
        } while (token);

        if (offered.size === 0) return [];

        // 2. Their memory and vCPU counts.
        const res = await this.send(where, (c) =>
            c.send(
                new DescribeInstanceTypesCommand({
                    InstanceTypes: [...offered] as DescribeInstanceTypesCommandInput["InstanceTypes"],
                }),
            ),
        );

        const plans: AwsPlan[] = [];
        for (const t of res.InstanceTypes ?? []) {
            if (!t.InstanceType) continue;
            const id = String(t.InstanceType);

            plans.push({
                id,
                label: id,
                class: FAMILY_CLASS[id.split(".")[0]] ?? "general",
                memory_mb: Number(t.MemoryInfo?.SizeInMiB ?? 0),
                vcpus: Number(t.VCpuInfo?.DefaultVCpus ?? 0),
                disk_gb: ROOT_VOLUME_GB,
                monthly: 0, // not looked up: the price depends on the Pricing API
                hourly: 0,
                currency: "USD",
            });
        }
        return plans.sort((a, b) => a.memory_mb - b.memory_mb || a.vcpus - b.vcpus || a.id.localeCompare(b.id));
    }

    // ---- Machines ----

    /** Newest Canonical AMI for a logical image id, in one region. */
    private async resolveAmi(region: string, imageId: string): Promise<string> {
        const image = IMAGES.find((i) => i.id === imageId);
        if (!image) throw new AwsError("That operating system isn't supported on AWS.", 400, "UnknownImage");

        const res = await this.send(region, (c) =>
            c.send(
                new DescribeImagesCommand({
                    Owners: [CANONICAL_OWNER],
                    Filters: [
                        { Name: "name", Values: [image.pattern] },
                        { Name: "state", Values: ["available"] },
                        { Name: "architecture", Values: ["x86_64"] },
                        { Name: "root-device-type", Values: ["ebs"] },
                        { Name: "virtualization-type", Values: ["hvm"] },
                    ],
                }),
            ),
        );

        const newest = (res.Images ?? [])
            .filter((i) => i.ImageId)
            .sort((a, b) => String(b.CreationDate ?? "").localeCompare(String(a.CreationDate ?? "")))[0];

        if (!newest?.ImageId) {
            throw new AwsError(`No ${image.label} image was found in ${region}.`, 404, "NoImage");
        }
        return newest.ImageId;
    }

    /**
     * The shared security group for this region. Created once, then reused.
     * Everything inbound is open, exactly like the other providers: the ufw
     * rules on the server (Firewall page) decide what is reachable.
     */
    private async ensureSecurityGroup(region: string): Promise<string> {
        const vpcs = await this.send(region, (c) =>
            c.send(new DescribeVpcsCommand({ Filters: [{ Name: "is-default", Values: ["true"] }] })),
        );
        const vpcId = vpcs.Vpcs?.[0]?.VpcId;

        if (!vpcId) {
            throw new AwsError(
                `There is no default VPC in ${region}. Create one in the VPC console (Actions, Create default VPC) or choose another region.`,
                400,
                "NoDefaultVpc",
            );
        }

        const find = async (): Promise<string> => {
            const res = await this.send(region, (c) =>
                c.send(
                    new DescribeSecurityGroupsCommand({
                        Filters: [
                            { Name: "group-name", Values: [SECURITY_GROUP_NAME] },
                            { Name: "vpc-id", Values: [vpcId] },
                        ],
                    }),
                ),
            );
            return res.SecurityGroups?.[0]?.GroupId ?? "";
        };

        let groupId = await find();

        if (!groupId) {
            try {
                const created = await this.send(region, (c) =>
                    c.send(
                        new CreateSecurityGroupCommand({
                            GroupName: SECURITY_GROUP_NAME,
                            Description: "Tylix deployer: inbound open, firewall managed by ufw on the server",
                            VpcId: vpcId,
                        }),
                    ),
                );
                groupId = created.GroupId ?? "";
            } catch (error) {
                // Two provisions racing to create it: the other one won.
                if (error instanceof AwsError && error.code === "InvalidGroup.Duplicate") {
                    groupId = await find();
                } else {
                    throw error;
                }
            }
        }

        if (!groupId) throw new AwsError("Couldn't create the security group.", 500, "SecurityGroup");

        // Always (re)applied, so a group left empty by an earlier failed run gets healed.
        try {
            await this.send(region, (c) =>
                c.send(
                    new AuthorizeSecurityGroupIngressCommand({
                        GroupId: groupId,
                        IpPermissions: [
                            {
                                IpProtocol: "-1",
                                IpRanges: [{ CidrIp: "0.0.0.0/0", Description: "All inbound, filtered by ufw" }],
                            },
                        ],
                    }),
                ),
            );
        } catch (error) {
            if (!(error instanceof AwsError && error.code === "InvalidPermission.Duplicate")) throw error;
        }

        return groupId;
    }

    async createInstance(input: CreateAwsInstanceInput): Promise<AwsInstance> {
        const securityGroupId = await this.ensureSecurityGroup(input.region);
        const imageId = await this.resolveAmi(input.region, input.image);

        const tags = [
            { Key: "Name", Value: input.name },
            { Key: "tylix-provision", Value: String(input.provisionId) },
            { Key: "managed-by", Value: "tylix-deploy" },
        ];

        const res = await this.send(input.region, (c) =>
            c.send(
                new RunInstancesCommand({
                    ImageId: imageId,
                    InstanceType: input.type as RunInstancesCommandInput["InstanceType"],
                    MinCount: 1,
                    MaxCount: 1,
                    SecurityGroupIds: [securityGroupId],
                    UserData: buildUserData(input.authorizedKeys),
                    // Makes the create idempotent: a re-run after a crash gets the same machine back.
                    ClientToken: `tylix-provision-${input.provisionId}`,
                    BlockDeviceMappings: [
                        {
                            DeviceName: "/dev/sda1",
                            Ebs: { VolumeSize: ROOT_VOLUME_GB, VolumeType: "gp3", DeleteOnTermination: true },
                        },
                    ],
                    MetadataOptions: { HttpTokens: "required", HttpEndpoint: "enabled" },
                    TagSpecifications: [
                        { ResourceType: "instance", Tags: tags },
                        { ResourceType: "volume", Tags: tags },
                    ],
                }),
            ),
        );

        const raw = res.Instances?.[0];
        if (!raw?.InstanceId) throw new AwsError("AWS accepted the request but returned no instance.", 502, "NoInstance");

        return toInstance(input.region, raw);
    }

    async getInstance(ref: string): Promise<AwsInstance> {
        const { region, id } = splitRef(ref);

        const res = await this.send(region, (c) => c.send(new DescribeInstancesCommand({ InstanceIds: [id] })));
        const raw = (res.Reservations ?? []).flatMap((r) => r.Instances ?? [])[0];

        if (!raw) throw new AwsError("Instance not found.", 404, "InvalidInstanceID.NotFound");
        return toInstance(region, raw);
    }

    /** Our own machine for this provision, found by tag (never by name). Terminated ones don't count. */
    async findByTag(region: string, provisionId: number): Promise<AwsInstance | null> {
        const res = await this.send(region, (c) =>
            c.send(
                new DescribeInstancesCommand({
                    Filters: [
                        { Name: "tag:tylix-provision", Values: [String(provisionId)] },
                        { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] },
                    ],
                }),
            ),
        );

        const raw = (res.Reservations ?? []).flatMap((r) => r.Instances ?? [])[0];
        return raw ? toInstance(region, raw) : null;
    }

    /** Already gone counts as success. */
    async deleteInstance(ref: string): Promise<void> {
        const { region, id } = splitRef(ref);

        try {
            await this.send(region, (c) => c.send(new TerminateInstancesCommand({ InstanceIds: [id] })));
        } catch (error) {
            if (error instanceof AwsError && error.code === "InvalidInstanceID.NotFound") return;
            throw error;
        }
    }
}