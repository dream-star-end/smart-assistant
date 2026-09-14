import { generateKeyPairSync,sign } from 'node:crypto'
import { MODEL_AUTHORITY_VERSION,MODEL_AUTHORITY_FIELD,authoritySigningInput,turnLeaseSigningInput,
  encodeAuthorityEnvelope,encodeTurnLeaseEnvelope,type ModelAuthorityPayload,type TurnLease } from '@openclaude/protocol'
import { ModelAuthorityConsumer } from '../../modelAuthority.js'
/** Private real signature consumer, not attachTurnAuthority or forged descriptor. */
export function signedOwner(uid: number) {
  const {privateKey,publicKey}=generateKeyPairSync('ed25519'),keyId='private-owner'
  const jwk=publicKey.export({format:'jwk'}) as {x:string},now=Date.now()
  const consumer=new ModelAuthorityConsumer({uid,containerId:17,keyring:new Map([[keyId,new Uint8Array(Buffer.from(jwk.x,'base64url'))]])})
  const connection=consumer.newConnection()
  const payload: ModelAuthorityPayload={v:MODEL_AUTHORITY_VERSION,keyId,uid,containerId:17,authorityTurnId:'private-turn-'+uid,
    connectionChallenge:connection.challenge,canonicalModel:'glm-5.3-zai',engine:'ccb',
    executionDescriptor:{capabilityProfile:{ccb:{capabilityZero:true,supportsThinking:true}},capabilitySchemaVersion:1,
      contextWindow:200000,supportsVision:false,supportedEfforts:[]},executionRevision:'private',securityEpoch:1,issuedAt:now,expiresAt:now+60000}
  const lease:TurnLease={v:payload.v,keyId,uid,containerId:17,authorityTurnId:payload.authorityTurnId,
    connectionChallenge:connection.challenge,canonicalModel:payload.canonicalModel,securityEpoch:1,issuedAt:now,expiresAt:now+60000}
  return consumer.consume({model:payload.canonicalModel,[MODEL_AUTHORITY_FIELD]:{
    authority:encodeAuthorityEnvelope(payload,sign(null,authoritySigningInput(payload),privateKey)),
    lease:encodeTurnLeaseEnvelope(lease,sign(null,turnLeaseSigningInput(lease),privateKey))}},connection)
}
