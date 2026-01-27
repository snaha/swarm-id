import { z } from "zod";
export declare const SWARM_SECRET_PREFIX = "swarm-secret-";
export declare const STORAGE_KEY_ACCOUNTS = "swarm-id-accounts";
export declare const STORAGE_KEY_IDENTITIES = "swarm-id-identities";
export declare const STORAGE_KEY_CONNECTED_APPS = "swarm-id-connected-apps";
export declare const STORAGE_KEY_POSTAGE_STAMPS = "swarm-id-postage-stamps";
export declare const STORAGE_KEY_NETWORK_SETTINGS = "swarm-id-network-settings";
export declare const ReferenceSchema: z.ZodString;
export declare const BatchIdSchema: z.ZodString;
export declare const AddressSchema: z.ZodString;
export declare const PrivateKeySchema: z.ZodString;
export type Reference = z.infer<typeof ReferenceSchema>;
export type BatchId = z.infer<typeof BatchIdSchema>;
export type Address = z.infer<typeof AddressSchema>;
export type PrivateKey = z.infer<typeof PrivateKeySchema>;
export declare const UploadOptionsSchema: z.ZodOptional<z.ZodObject<{
    pin: z.ZodOptional<z.ZodBoolean>;
    encrypt: z.ZodOptional<z.ZodBoolean>;
    tag: z.ZodOptional<z.ZodNumber>;
    deferred: z.ZodOptional<z.ZodBoolean>;
    redundancyLevel: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>>;
export declare const RequestOptionsSchema: z.ZodOptional<z.ZodObject<{
    timeout: z.ZodOptional<z.ZodNumber>;
    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>>;
export declare const DownloadOptionsSchema: z.ZodOptional<z.ZodObject<{
    redundancyStrategy: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>]>>;
    fallback: z.ZodOptional<z.ZodBoolean>;
    timeoutMs: z.ZodOptional<z.ZodNumber>;
    actPublisher: z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodString]>;
    actHistoryAddress: z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodString]>;
    actTimestamp: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
}, z.core.$strip>>;
export interface UploadProgress {
    total: number;
    processed: number;
}
export interface UploadOptions {
    pin?: boolean;
    encrypt?: boolean;
    tag?: number;
    deferred?: boolean;
    redundancyLevel?: number;
    onProgress?: (progress: UploadProgress) => void;
}
export type RequestOptions = z.infer<typeof RequestOptionsSchema>;
export type DownloadOptions = z.infer<typeof DownloadOptionsSchema>;
export declare const UploadResultSchema: z.ZodObject<{
    reference: z.ZodString;
    tagUid: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const FileDataSchema: z.ZodObject<{
    name: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
}, z.core.$strip>;
export declare const PostageBatchSchema: z.ZodObject<{
    batchID: z.ZodString;
    utilization: z.ZodNumber;
    usable: z.ZodBoolean;
    label: z.ZodString;
    depth: z.ZodNumber;
    amount: z.ZodString;
    bucketDepth: z.ZodNumber;
    blockNumber: z.ZodNumber;
    immutableFlag: z.ZodBoolean;
    exists: z.ZodBoolean;
    batchTTL: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type UploadResult = z.infer<typeof UploadResultSchema>;
export type FileData = z.infer<typeof FileDataSchema>;
export type PostageBatch = z.infer<typeof PostageBatchSchema>;
export declare const AuthStatusSchema: z.ZodObject<{
    authenticated: z.ZodBoolean;
    origin: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type AuthStatus = z.infer<typeof AuthStatusSchema>;
export declare const ConnectionInfoSchema: z.ZodObject<{
    canUpload: z.ZodBoolean;
    identity: z.ZodOptional<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        address: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type ConnectionInfo = z.infer<typeof ConnectionInfoSchema>;
export declare const ButtonStylesSchema: z.ZodOptional<z.ZodObject<{
    backgroundColor: z.ZodOptional<z.ZodString>;
    color: z.ZodOptional<z.ZodString>;
    border: z.ZodOptional<z.ZodString>;
    borderRadius: z.ZodOptional<z.ZodString>;
    padding: z.ZodOptional<z.ZodString>;
    fontSize: z.ZodOptional<z.ZodString>;
    fontFamily: z.ZodOptional<z.ZodString>;
    fontWeight: z.ZodOptional<z.ZodString>;
    cursor: z.ZodOptional<z.ZodString>;
    width: z.ZodOptional<z.ZodString>;
    height: z.ZodOptional<z.ZodString>;
}, z.core.$strip>>;
export type ButtonStyles = z.infer<typeof ButtonStylesSchema>;
export declare const AppMetadataSchema: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    icon: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type AppMetadata = z.infer<typeof AppMetadataSchema>;
export declare const ButtonConfigSchema: z.ZodOptional<z.ZodObject<{
    connectText: z.ZodOptional<z.ZodString>;
    disconnectText: z.ZodOptional<z.ZodString>;
    loadingText: z.ZodOptional<z.ZodString>;
    backgroundColor: z.ZodOptional<z.ZodString>;
    color: z.ZodOptional<z.ZodString>;
    borderRadius: z.ZodOptional<z.ZodString>;
}, z.core.$strip>>;
export interface ButtonConfig {
    connectText?: string;
    disconnectText?: string;
    loadingText?: string;
    backgroundColor?: string;
    color?: string;
    borderRadius?: string;
}
export declare const ParentIdentifyMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"parentIdentify">;
    beeApiUrl: z.ZodOptional<z.ZodString>;
    popupMode: z.ZodOptional<z.ZodEnum<{
        popup: "popup";
        window: "window";
    }>>;
    metadata: z.ZodObject<{
        name: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        icon: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    buttonConfig: z.ZodOptional<z.ZodObject<{
        connectText: z.ZodOptional<z.ZodString>;
        disconnectText: z.ZodOptional<z.ZodString>;
        loadingText: z.ZodOptional<z.ZodString>;
        backgroundColor: z.ZodOptional<z.ZodString>;
        color: z.ZodOptional<z.ZodString>;
        borderRadius: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const CheckAuthMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"checkAuth">;
    requestId: z.ZodString;
}, z.core.$strip>;
export declare const DisconnectMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"disconnect">;
    requestId: z.ZodString;
}, z.core.$strip>;
export declare const RequestAuthMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"requestAuth">;
    styles: z.ZodOptional<z.ZodObject<{
        backgroundColor: z.ZodOptional<z.ZodString>;
        color: z.ZodOptional<z.ZodString>;
        border: z.ZodOptional<z.ZodString>;
        borderRadius: z.ZodOptional<z.ZodString>;
        padding: z.ZodOptional<z.ZodString>;
        fontSize: z.ZodOptional<z.ZodString>;
        fontFamily: z.ZodOptional<z.ZodString>;
        fontWeight: z.ZodOptional<z.ZodString>;
        cursor: z.ZodOptional<z.ZodString>;
        width: z.ZodOptional<z.ZodString>;
        height: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const UploadDataMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"uploadData">;
    requestId: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    options: z.ZodOptional<z.ZodObject<{
        pin: z.ZodOptional<z.ZodBoolean>;
        encrypt: z.ZodOptional<z.ZodBoolean>;
        tag: z.ZodOptional<z.ZodNumber>;
        deferred: z.ZodOptional<z.ZodBoolean>;
        redundancyLevel: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    enableProgress: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export declare const DownloadDataMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"downloadData">;
    requestId: z.ZodString;
    reference: z.ZodString;
    options: z.ZodOptional<z.ZodObject<{
        redundancyStrategy: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>]>>;
        fallback: z.ZodOptional<z.ZodBoolean>;
        timeoutMs: z.ZodOptional<z.ZodNumber>;
        actPublisher: z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodString]>;
        actHistoryAddress: z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodString]>;
        actTimestamp: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const UploadFileMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"uploadFile">;
    requestId: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    name: z.ZodOptional<z.ZodString>;
    options: z.ZodOptional<z.ZodObject<{
        pin: z.ZodOptional<z.ZodBoolean>;
        encrypt: z.ZodOptional<z.ZodBoolean>;
        tag: z.ZodOptional<z.ZodNumber>;
        deferred: z.ZodOptional<z.ZodBoolean>;
        redundancyLevel: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const DownloadFileMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"downloadFile">;
    requestId: z.ZodString;
    reference: z.ZodString;
    path: z.ZodOptional<z.ZodString>;
    options: z.ZodOptional<z.ZodObject<{
        redundancyStrategy: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>]>>;
        fallback: z.ZodOptional<z.ZodBoolean>;
        timeoutMs: z.ZodOptional<z.ZodNumber>;
        actPublisher: z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodString]>;
        actHistoryAddress: z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodString]>;
        actTimestamp: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const UploadChunkMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"uploadChunk">;
    requestId: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    options: z.ZodOptional<z.ZodObject<{
        pin: z.ZodOptional<z.ZodBoolean>;
        encrypt: z.ZodOptional<z.ZodBoolean>;
        tag: z.ZodOptional<z.ZodNumber>;
        deferred: z.ZodOptional<z.ZodBoolean>;
        redundancyLevel: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const DownloadChunkMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"downloadChunk">;
    requestId: z.ZodString;
    reference: z.ZodString;
    options: z.ZodOptional<z.ZodObject<{
        redundancyStrategy: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>]>>;
        fallback: z.ZodOptional<z.ZodBoolean>;
        timeoutMs: z.ZodOptional<z.ZodNumber>;
        actPublisher: z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodString]>;
        actHistoryAddress: z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodString]>;
        actTimestamp: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const GetConnectionInfoMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"getConnectionInfo">;
    requestId: z.ZodString;
}, z.core.$strip>;
export declare const IsConnectedMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"isConnected">;
    requestId: z.ZodString;
}, z.core.$strip>;
export declare const GsocMineMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"gsocMine">;
    requestId: z.ZodString;
    targetOverlay: z.ZodString;
    identifier: z.ZodString;
    proximity: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const GsocSendMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"gsocSend">;
    requestId: z.ZodString;
    signer: z.ZodString;
    identifier: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    options: z.ZodOptional<z.ZodObject<{
        pin: z.ZodOptional<z.ZodBoolean>;
        encrypt: z.ZodOptional<z.ZodBoolean>;
        tag: z.ZodOptional<z.ZodNumber>;
        deferred: z.ZodOptional<z.ZodBoolean>;
        redundancyLevel: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const ParentToIframeMessageSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"parentIdentify">;
    beeApiUrl: z.ZodOptional<z.ZodString>;
    popupMode: z.ZodOptional<z.ZodEnum<{
        popup: "popup";
        window: "window";
    }>>;
    metadata: z.ZodObject<{
        name: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        icon: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    buttonConfig: z.ZodOptional<z.ZodObject<{
        connectText: z.ZodOptional<z.ZodString>;
        disconnectText: z.ZodOptional<z.ZodString>;
        loadingText: z.ZodOptional<z.ZodString>;
        backgroundColor: z.ZodOptional<z.ZodString>;
        color: z.ZodOptional<z.ZodString>;
        borderRadius: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"checkAuth">;
    requestId: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"disconnect">;
    requestId: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"requestAuth">;
    styles: z.ZodOptional<z.ZodObject<{
        backgroundColor: z.ZodOptional<z.ZodString>;
        color: z.ZodOptional<z.ZodString>;
        border: z.ZodOptional<z.ZodString>;
        borderRadius: z.ZodOptional<z.ZodString>;
        padding: z.ZodOptional<z.ZodString>;
        fontSize: z.ZodOptional<z.ZodString>;
        fontFamily: z.ZodOptional<z.ZodString>;
        fontWeight: z.ZodOptional<z.ZodString>;
        cursor: z.ZodOptional<z.ZodString>;
        width: z.ZodOptional<z.ZodString>;
        height: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"uploadData">;
    requestId: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    options: z.ZodOptional<z.ZodObject<{
        pin: z.ZodOptional<z.ZodBoolean>;
        encrypt: z.ZodOptional<z.ZodBoolean>;
        tag: z.ZodOptional<z.ZodNumber>;
        deferred: z.ZodOptional<z.ZodBoolean>;
        redundancyLevel: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    enableProgress: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"downloadData">;
    requestId: z.ZodString;
    reference: z.ZodString;
    options: z.ZodOptional<z.ZodObject<{
        redundancyStrategy: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>]>>;
        fallback: z.ZodOptional<z.ZodBoolean>;
        timeoutMs: z.ZodOptional<z.ZodNumber>;
        actPublisher: z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodString]>;
        actHistoryAddress: z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodString]>;
        actTimestamp: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"uploadFile">;
    requestId: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    name: z.ZodOptional<z.ZodString>;
    options: z.ZodOptional<z.ZodObject<{
        pin: z.ZodOptional<z.ZodBoolean>;
        encrypt: z.ZodOptional<z.ZodBoolean>;
        tag: z.ZodOptional<z.ZodNumber>;
        deferred: z.ZodOptional<z.ZodBoolean>;
        redundancyLevel: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"downloadFile">;
    requestId: z.ZodString;
    reference: z.ZodString;
    path: z.ZodOptional<z.ZodString>;
    options: z.ZodOptional<z.ZodObject<{
        redundancyStrategy: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>]>>;
        fallback: z.ZodOptional<z.ZodBoolean>;
        timeoutMs: z.ZodOptional<z.ZodNumber>;
        actPublisher: z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodString]>;
        actHistoryAddress: z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodString]>;
        actTimestamp: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"uploadChunk">;
    requestId: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    options: z.ZodOptional<z.ZodObject<{
        pin: z.ZodOptional<z.ZodBoolean>;
        encrypt: z.ZodOptional<z.ZodBoolean>;
        tag: z.ZodOptional<z.ZodNumber>;
        deferred: z.ZodOptional<z.ZodBoolean>;
        redundancyLevel: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"downloadChunk">;
    requestId: z.ZodString;
    reference: z.ZodString;
    options: z.ZodOptional<z.ZodObject<{
        redundancyStrategy: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>]>>;
        fallback: z.ZodOptional<z.ZodBoolean>;
        timeoutMs: z.ZodOptional<z.ZodNumber>;
        actPublisher: z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodString]>;
        actHistoryAddress: z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodString]>;
        actTimestamp: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"getConnectionInfo">;
    requestId: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"isConnected">;
    requestId: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"gsocMine">;
    requestId: z.ZodString;
    targetOverlay: z.ZodString;
    identifier: z.ZodString;
    proximity: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"gsocSend">;
    requestId: z.ZodString;
    signer: z.ZodString;
    identifier: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    options: z.ZodOptional<z.ZodObject<{
        pin: z.ZodOptional<z.ZodBoolean>;
        encrypt: z.ZodOptional<z.ZodBoolean>;
        tag: z.ZodOptional<z.ZodNumber>;
        deferred: z.ZodOptional<z.ZodBoolean>;
        redundancyLevel: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>], "type">;
export type ParentIdentifyMessage = z.infer<typeof ParentIdentifyMessageSchema>;
export type CheckAuthMessage = z.infer<typeof CheckAuthMessageSchema>;
export type DisconnectMessage = z.infer<typeof DisconnectMessageSchema>;
export type RequestAuthMessage = z.infer<typeof RequestAuthMessageSchema>;
export type UploadDataMessage = z.infer<typeof UploadDataMessageSchema>;
export type DownloadDataMessage = z.infer<typeof DownloadDataMessageSchema>;
export type UploadFileMessage = z.infer<typeof UploadFileMessageSchema>;
export type DownloadFileMessage = z.infer<typeof DownloadFileMessageSchema>;
export type UploadChunkMessage = z.infer<typeof UploadChunkMessageSchema>;
export type DownloadChunkMessage = z.infer<typeof DownloadChunkMessageSchema>;
export type GetConnectionInfoMessage = z.infer<typeof GetConnectionInfoMessageSchema>;
export type IsConnectedMessage = z.infer<typeof IsConnectedMessageSchema>;
export type GsocMineMessage = z.infer<typeof GsocMineMessageSchema>;
export type GsocSendMessage = z.infer<typeof GsocSendMessageSchema>;
export type ParentToIframeMessage = z.infer<typeof ParentToIframeMessageSchema>;
export declare const ProxyReadyMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"proxyReady">;
    authenticated: z.ZodBoolean;
    parentOrigin: z.ZodString;
}, z.core.$strip>;
export declare const InitErrorMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"initError">;
    error: z.ZodString;
}, z.core.$strip>;
export declare const AuthStatusResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"authStatusResponse">;
    requestId: z.ZodString;
    authenticated: z.ZodBoolean;
    origin: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const DisconnectResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"disconnectResponse">;
    requestId: z.ZodString;
    success: z.ZodBoolean;
}, z.core.$strip>;
export declare const AuthSuccessMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"authSuccess">;
    origin: z.ZodString;
}, z.core.$strip>;
export declare const UploadDataResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"uploadDataResponse">;
    requestId: z.ZodString;
    reference: z.ZodString;
    tagUid: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const DownloadDataResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"downloadDataResponse">;
    requestId: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
}, z.core.$strip>;
export declare const UploadFileResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"uploadFileResponse">;
    requestId: z.ZodString;
    reference: z.ZodString;
    tagUid: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const DownloadFileResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"downloadFileResponse">;
    requestId: z.ZodString;
    name: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
}, z.core.$strip>;
export declare const UploadChunkResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"uploadChunkResponse">;
    requestId: z.ZodString;
    reference: z.ZodString;
}, z.core.$strip>;
export declare const DownloadChunkResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"downloadChunkResponse">;
    requestId: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
}, z.core.$strip>;
export declare const UploadProgressMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"uploadProgress">;
    requestId: z.ZodString;
    total: z.ZodNumber;
    processed: z.ZodNumber;
}, z.core.$strip>;
export declare const ErrorMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"error">;
    requestId: z.ZodString;
    error: z.ZodString;
}, z.core.$strip>;
export declare const ConnectionInfoResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"connectionInfoResponse">;
    requestId: z.ZodString;
    canUpload: z.ZodBoolean;
    identity: z.ZodOptional<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        address: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const ConnectResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"connectResponse">;
    requestId: z.ZodString;
    success: z.ZodBoolean;
}, z.core.$strip>;
export declare const IsConnectedResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"isConnectedResponse">;
    requestId: z.ZodString;
    connected: z.ZodBoolean;
}, z.core.$strip>;
export declare const GsocMineResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"gsocMineResponse">;
    requestId: z.ZodString;
    signer: z.ZodString;
}, z.core.$strip>;
export declare const GsocSendResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"gsocSendResponse">;
    requestId: z.ZodString;
    reference: z.ZodString;
    tagUid: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const IframeToParentMessageSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"proxyReady">;
    authenticated: z.ZodBoolean;
    parentOrigin: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"initError">;
    error: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"authStatusResponse">;
    requestId: z.ZodString;
    authenticated: z.ZodBoolean;
    origin: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"disconnectResponse">;
    requestId: z.ZodString;
    success: z.ZodBoolean;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"authSuccess">;
    origin: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"uploadDataResponse">;
    requestId: z.ZodString;
    reference: z.ZodString;
    tagUid: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"downloadDataResponse">;
    requestId: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"uploadFileResponse">;
    requestId: z.ZodString;
    reference: z.ZodString;
    tagUid: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"downloadFileResponse">;
    requestId: z.ZodString;
    name: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"uploadChunkResponse">;
    requestId: z.ZodString;
    reference: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"downloadChunkResponse">;
    requestId: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"uploadProgress">;
    requestId: z.ZodString;
    total: z.ZodNumber;
    processed: z.ZodNumber;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"error">;
    requestId: z.ZodString;
    error: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"connectionInfoResponse">;
    requestId: z.ZodString;
    canUpload: z.ZodBoolean;
    identity: z.ZodOptional<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        address: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"connectResponse">;
    requestId: z.ZodString;
    success: z.ZodBoolean;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"isConnectedResponse">;
    requestId: z.ZodString;
    connected: z.ZodBoolean;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"gsocMineResponse">;
    requestId: z.ZodString;
    signer: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"gsocSendResponse">;
    requestId: z.ZodString;
    reference: z.ZodString;
    tagUid: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>], "type">;
export type ProxyReadyMessage = z.infer<typeof ProxyReadyMessageSchema>;
export type InitErrorMessage = z.infer<typeof InitErrorMessageSchema>;
export type AuthStatusResponseMessage = z.infer<typeof AuthStatusResponseMessageSchema>;
export type DisconnectResponseMessage = z.infer<typeof DisconnectResponseMessageSchema>;
export type AuthSuccessMessage = z.infer<typeof AuthSuccessMessageSchema>;
export type UploadDataResponseMessage = z.infer<typeof UploadDataResponseMessageSchema>;
export type DownloadDataResponseMessage = z.infer<typeof DownloadDataResponseMessageSchema>;
export type UploadFileResponseMessage = z.infer<typeof UploadFileResponseMessageSchema>;
export type DownloadFileResponseMessage = z.infer<typeof DownloadFileResponseMessageSchema>;
export type UploadChunkResponseMessage = z.infer<typeof UploadChunkResponseMessageSchema>;
export type DownloadChunkResponseMessage = z.infer<typeof DownloadChunkResponseMessageSchema>;
export type UploadProgressMessage = z.infer<typeof UploadProgressMessageSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
export type ConnectionInfoResponseMessage = z.infer<typeof ConnectionInfoResponseMessageSchema>;
export type ConnectResponseMessage = z.infer<typeof ConnectResponseMessageSchema>;
export type IsConnectedResponseMessage = z.infer<typeof IsConnectedResponseMessageSchema>;
export type GsocMineResponseMessage = z.infer<typeof GsocMineResponseMessageSchema>;
export type GsocSendResponseMessage = z.infer<typeof GsocSendResponseMessageSchema>;
export type IframeToParentMessage = z.infer<typeof IframeToParentMessageSchema>;
export declare const AuthDataSchema: z.ZodObject<{
    secret: z.ZodString;
    postageBatchId: z.ZodOptional<z.ZodString>;
    signerKey: z.ZodOptional<z.ZodString>;
    networkSettings: z.ZodOptional<z.ZodObject<{
        beeNodeUrl: z.ZodString;
        gnosisRpcUrl: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type AuthData = z.infer<typeof AuthDataSchema>;
export declare const SetSecretMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"setSecret">;
    appOrigin: z.ZodString;
    data: z.ZodObject<{
        secret: z.ZodString;
        postageBatchId: z.ZodOptional<z.ZodString>;
        signerKey: z.ZodOptional<z.ZodString>;
        networkSettings: z.ZodOptional<z.ZodObject<{
            beeNodeUrl: z.ZodString;
            gnosisRpcUrl: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const PopupToIframeMessageSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"setSecret">;
    appOrigin: z.ZodString;
    data: z.ZodObject<{
        secret: z.ZodString;
        postageBatchId: z.ZodOptional<z.ZodString>;
        signerKey: z.ZodOptional<z.ZodString>;
        networkSettings: z.ZodOptional<z.ZodObject<{
            beeNodeUrl: z.ZodString;
            gnosisRpcUrl: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>], "type">;
export type SetSecretMessage = z.infer<typeof SetSecretMessageSchema>;
export type PopupToIframeMessage = z.infer<typeof PopupToIframeMessageSchema>;
export interface ClientOptions {
    iframeOrigin: string;
    iframePath?: string;
    timeout?: number;
    onAuthChange?: (authenticated: boolean) => void;
    popupMode?: "popup" | "window";
    metadata: AppMetadata;
    buttonConfig?: ButtonConfig;
    containerId?: string;
}
export interface AuthOptions {
    masterKeyStorageKey?: string;
}
export type { PasskeyAccount, EthereumAccount, Account, Identity, ConnectedApp, PostageStamp, } from "./schemas";
//# sourceMappingURL=types.d.ts.map