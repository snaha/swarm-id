/**
 * Entity Schemas with Zod
 *
 * Defines Zod schemas for storage entities with transforms to convert
 * serialized primitives to bee-js runtime types. Types are derived using
 * z.infer to guarantee schema/type consistency.
 */
import { z } from "zod";
import { EthAddress, BatchId, Bytes, PrivateKey } from "@ethersphere/bee-js";
export declare const DEFAULT_BEE_NODE_URL = "https://api.gateway.ethswarm.org/";
export declare const DEFAULT_GNOSIS_RPC_URL = "https://xdai.fairdatasociety.org/";
/**
 * Account Sync Type - whether account is local-only or synced to Swarm
 */
export declare const AccountSyncTypeSchema: z.ZodEnum<{
    local: "local";
    synced: "synced";
}>;
export type AccountSyncType = z.infer<typeof AccountSyncTypeSchema>;
/**
 * Passkey Account Schema V1
 */
export declare const PasskeyAccountSchemaV1: z.ZodObject<{
    id: z.ZodPipe<z.ZodString, z.ZodTransform<EthAddress, string>>;
    name: z.ZodString;
    createdAt: z.ZodNumber;
    type: z.ZodLiteral<"passkey">;
    credentialId: z.ZodString;
    swarmEncryptionKey: z.ZodString;
    syncType: z.ZodEnum<{
        local: "local";
        synced: "synced";
    }>;
    defaultPostageStampBatchID: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<BatchId, string>>>;
}, z.core.$strip>;
/**
 * Ethereum Account Schema V1
 */
export declare const EthereumAccountSchemaV1: z.ZodObject<{
    id: z.ZodPipe<z.ZodString, z.ZodTransform<EthAddress, string>>;
    name: z.ZodString;
    createdAt: z.ZodNumber;
    type: z.ZodLiteral<"ethereum">;
    ethereumAddress: z.ZodPipe<z.ZodString, z.ZodTransform<EthAddress, string>>;
    encryptedMasterKey: z.ZodPipe<z.ZodArray<z.ZodNumber>, z.ZodTransform<Bytes, number[]>>;
    encryptionSalt: z.ZodPipe<z.ZodArray<z.ZodNumber>, z.ZodTransform<Bytes, number[]>>;
    encryptedSecretSeed: z.ZodPipe<z.ZodArray<z.ZodNumber>, z.ZodTransform<Bytes, number[]>>;
    swarmEncryptionKey: z.ZodString;
    syncType: z.ZodEnum<{
        local: "local";
        synced: "synced";
    }>;
    defaultPostageStampBatchID: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<BatchId, string>>>;
}, z.core.$strip>;
/**
 * Account Schema V1 (discriminated union)
 */
export declare const AccountSchemaV1: z.ZodDiscriminatedUnion<[z.ZodObject<{
    id: z.ZodPipe<z.ZodString, z.ZodTransform<EthAddress, string>>;
    name: z.ZodString;
    createdAt: z.ZodNumber;
    type: z.ZodLiteral<"passkey">;
    credentialId: z.ZodString;
    swarmEncryptionKey: z.ZodString;
    syncType: z.ZodEnum<{
        local: "local";
        synced: "synced";
    }>;
    defaultPostageStampBatchID: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<BatchId, string>>>;
}, z.core.$strip>, z.ZodObject<{
    id: z.ZodPipe<z.ZodString, z.ZodTransform<EthAddress, string>>;
    name: z.ZodString;
    createdAt: z.ZodNumber;
    type: z.ZodLiteral<"ethereum">;
    ethereumAddress: z.ZodPipe<z.ZodString, z.ZodTransform<EthAddress, string>>;
    encryptedMasterKey: z.ZodPipe<z.ZodArray<z.ZodNumber>, z.ZodTransform<Bytes, number[]>>;
    encryptionSalt: z.ZodPipe<z.ZodArray<z.ZodNumber>, z.ZodTransform<Bytes, number[]>>;
    encryptedSecretSeed: z.ZodPipe<z.ZodArray<z.ZodNumber>, z.ZodTransform<Bytes, number[]>>;
    swarmEncryptionKey: z.ZodString;
    syncType: z.ZodEnum<{
        local: "local";
        synced: "synced";
    }>;
    defaultPostageStampBatchID: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<BatchId, string>>>;
}, z.core.$strip>], "type">;
/**
 * Identity Schema V1
 */
export declare const IdentitySchemaV1: z.ZodObject<{
    id: z.ZodString;
    accountId: z.ZodPipe<z.ZodString, z.ZodTransform<EthAddress, string>>;
    name: z.ZodString;
    defaultPostageStampBatchID: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<BatchId, string>>>;
    createdAt: z.ZodNumber;
    settings: z.ZodOptional<z.ZodObject<{
        appSessionDuration: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>;
/**
 * Connected App Schema V1 (no transforms needed - all primitives)
 */
export declare const ConnectedAppSchemaV1: z.ZodObject<{
    appUrl: z.ZodString;
    appName: z.ZodString;
    lastConnectedAt: z.ZodNumber;
    identityId: z.ZodString;
    appIcon: z.ZodOptional<z.ZodString>;
    appDescription: z.ZodOptional<z.ZodString>;
    connectedUntil: z.ZodOptional<z.ZodNumber>;
    appSecret: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * Postage Stamp Schema V1
 */
export declare const PostageStampSchemaV1: z.ZodObject<{
    accountId: z.ZodString;
    batchID: z.ZodPipe<z.ZodString, z.ZodTransform<BatchId, string>>;
    signerKey: z.ZodPipe<z.ZodString, z.ZodTransform<PrivateKey, string>>;
    utilization: z.ZodNumber;
    usable: z.ZodBoolean;
    depth: z.ZodNumber;
    amount: z.ZodNumber;
    bucketDepth: z.ZodNumber;
    blockNumber: z.ZodNumber;
    immutableFlag: z.ZodBoolean;
    exists: z.ZodBoolean;
    batchTTL: z.ZodOptional<z.ZodNumber>;
    createdAt: z.ZodNumber;
}, z.core.$strip>;
/**
 * Account Metadata Schema V1
 */
export declare const AccountMetadataSchemaV1: z.ZodObject<{
    defaultPostageStampBatchID: z.ZodOptional<z.ZodString>;
    createdAt: z.ZodNumber;
    lastModified: z.ZodNumber;
}, z.core.$strip>;
/**
 * Account State Snapshot Schema V1
 * Replaces identity-level sync with account-level sync
 */
export declare const AccountStateSnapshotSchemaV1: z.ZodObject<{
    version: z.ZodLiteral<1>;
    timestamp: z.ZodNumber;
    accountId: z.ZodString;
    metadata: z.ZodObject<{
        defaultPostageStampBatchID: z.ZodOptional<z.ZodString>;
        createdAt: z.ZodNumber;
        lastModified: z.ZodNumber;
    }, z.core.$strip>;
    identities: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        accountId: z.ZodPipe<z.ZodString, z.ZodTransform<EthAddress, string>>;
        name: z.ZodString;
        defaultPostageStampBatchID: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<BatchId, string>>>;
        createdAt: z.ZodNumber;
        settings: z.ZodOptional<z.ZodObject<{
            appSessionDuration: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    connectedApps: z.ZodArray<z.ZodObject<{
        appUrl: z.ZodString;
        appName: z.ZodString;
        lastConnectedAt: z.ZodNumber;
        identityId: z.ZodString;
        appIcon: z.ZodOptional<z.ZodString>;
        appDescription: z.ZodOptional<z.ZodString>;
        connectedUntil: z.ZodOptional<z.ZodNumber>;
        appSecret: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    postageStamps: z.ZodArray<z.ZodObject<{
        accountId: z.ZodString;
        batchID: z.ZodPipe<z.ZodString, z.ZodTransform<BatchId, string>>;
        signerKey: z.ZodPipe<z.ZodString, z.ZodTransform<PrivateKey, string>>;
        utilization: z.ZodNumber;
        usable: z.ZodBoolean;
        depth: z.ZodNumber;
        amount: z.ZodNumber;
        bucketDepth: z.ZodNumber;
        blockNumber: z.ZodNumber;
        immutableFlag: z.ZodBoolean;
        exists: z.ZodBoolean;
        batchTTL: z.ZodOptional<z.ZodNumber>;
        createdAt: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type PasskeyAccount = z.infer<typeof PasskeyAccountSchemaV1>;
export type EthereumAccount = z.infer<typeof EthereumAccountSchemaV1>;
export type Account = z.infer<typeof AccountSchemaV1>;
export type Identity = z.infer<typeof IdentitySchemaV1>;
export type ConnectedApp = z.infer<typeof ConnectedAppSchemaV1>;
export type PostageStamp = z.infer<typeof PostageStampSchemaV1>;
export type AccountMetadata = z.infer<typeof AccountMetadataSchemaV1>;
export type AccountStateSnapshot = z.infer<typeof AccountStateSnapshotSchemaV1>;
/**
 * Network Settings Schema V1
 * Stores user-configurable network endpoints (Bee node and Gnosis RPC)
 */
export declare const NetworkSettingsSchemaV1: z.ZodObject<{
    beeNodeUrl: z.ZodString;
    gnosisRpcUrl: z.ZodString;
}, z.core.$strip>;
export type NetworkSettings = z.infer<typeof NetworkSettingsSchemaV1>;
//# sourceMappingURL=schemas.d.ts.map