// Copyright (c) 2023 Cloudflare, Inc.
// Licensed under the Apache-2.0 license found in the LICENSE file or at https://opensource.org/licenses/Apache-2.0

import sjcl from './sjcl/index.js';
import {
    assertNever,
    emsa_pss_encode,
    i2osp,
    int_to_bytes,
    is_coprime,
    joinAll,
    os2ip,
    random_integer_uniform,
    rsasp1,
    rsavp1,
    type BigPublicKey,
    type BigSecretKey,
    type BigKeyPair,
} from './util.js';

export enum PrepareType {
    Deterministic = 0,
    Randomized = 32,
}

export type BlindOutput = { blindedMsg: Uint8Array; inv: Uint8Array };

export interface BlindRSAParams {
    name: string;
    hash: string;
    saltLength: number;
    prepareType: PrepareType;
}

export class PartiallyBlindRSA {
    private static readonly NAME = 'RSA-PSS';

    constructor(public readonly params: BlindRSAParams) {
        switch (params.prepareType) {
            case PrepareType.Deterministic:
            case PrepareType.Randomized:
                return;
            default:
                assertNever('PrepareType', params.prepareType);
        }
    }

    toString(): string {
        const hash = this.params.hash.replace('-', '');
        const pssType = 'PSS' + (this.params.saltLength === 0 ? 'ZERO' : '');
        const prepare = PrepareType[this.params.prepareType];
        return `RSAPBSSA-${hash}-${pssType}-${prepare}`;
    }

    prepare(msg: Uint8Array): Uint8Array {
        const msg_prefix_len = this.params.prepareType;
        const msg_prefix = crypto.getRandomValues(new Uint8Array(msg_prefix_len));
        return joinAll([msg_prefix, msg]);
    }

    // Returns the parameters of the input key: the JSONWebKey data, the length
    // in bits and in bytes of the modulus, and the hash function used.
    private async extractKeyParams(
        key: CryptoKey,
        type: 'public' | 'private',
    ): Promise<{
        jwkKey: JsonWebKey;
        modulusLengthBits: number;
        modulusLengthBytes: number;
        hash: string;
    }> {
        if (key.type !== type || key.algorithm.name !== PartiallyBlindRSA.NAME) {
            throw new Error(`key is not ${PartiallyBlindRSA.NAME}`);
        }
        if (!key.extractable) {
            throw new Error('key is not extractable');
        }

        const { modulusLength: modulusLengthBits, hash: hashFn } =
            key.algorithm as RsaHashedKeyGenParams;
        const modulusLengthBytes = Math.ceil(modulusLengthBits / 8);
        const hash = (hashFn as Algorithm).name;
        if (hash.toLowerCase() !== this.params.hash.toLowerCase()) {
            throw new Error(`hash is not ${this.params.hash}`);
        }
        const jwkKey = await crypto.subtle.exportKey('jwk', key);

        return { jwkKey, modulusLengthBits, modulusLengthBytes, hash };
    }

    async blind(publicKey: CryptoKey, msg: Uint8Array, info: Uint8Array): Promise<BlindOutput> {
        const {
            jwkKey,
            modulusLengthBits: modulusLength,
            modulusLengthBytes: kLen,
            hash,
        } = await this.extractKeyParams(publicKey, 'public');
        if (!jwkKey.n || !jwkKey.e) {
            throw new Error('key has invalid parameters');
        }
        const n = sjcl.bn.fromBits(sjcl.codec.base64url.toBits(jwkKey.n));
        const e = sjcl.bn.fromBits(sjcl.codec.base64url.toBits(jwkKey.e));
        const pk: BigPublicKey = { e, n };

        // 1. msg_prime = concat("msg", int_to_bytes(len(info), 4), info, msg)
        const msg_prime = joinAll([
            new TextEncoder().encode('msg'),
            int_to_bytes(info.length, 4),
            info,
            msg,
        ]);
        // 2. encoded_msg = EMSA-PSS-ENCODE(msg_prime, bit_len(n))
        //    with Hash, MGF, and salt_len as defined in the parameters
        // 3. If EMSA-PSS-ENCODE raises an error, raise the error and stop
        const opts = { sLen: this.params.saltLength, hash };
        const encoded_msg = await emsa_pss_encode(msg_prime, modulusLength - 1, opts);

        // 4. m = bytes_to_int(encoded_msg)
        const m = os2ip(encoded_msg);

        // 5. c = is_coprime(m, n)
        // 6. If c is false, raise an "invalid input" error
        //    and stop
        const c = is_coprime(m, n);
        if (c === false) {
            throw new Error('invalid input');
        }

        // 7. r = random_integer_uniform(1, n)
        const r = random_integer_uniform(n, kLen);

        // 8. inv = inverse_mod(r, n)
        // 9. If inverse_mod fails, raise a "blinding error" error
        //    and stop
        let inv: Uint8Array;
        try {
            inv = i2osp(r.inverseMod(n), kLen);
        } catch (e) {
            throw new Error(`blinding error: ${(e as Error).toString()}`);
        }

        // 10. pk_derived = DerivePublicKey(pk, info)
        const pk_derived = await this.derivePublicKey(pk, info);

        // 11. x = RSAVP1(pk, r)
        const x = rsavp1(pk_derived, r);

        // 12. z = m * x mod n
        const z = m.mulmod(x, n);

        // 13. blinded_msg = int_to_bytes(z, modulus_len)
        const blindedMsg = i2osp(z, kLen);

        // 14. output blinded_msg, inv
        return { blindedMsg, inv };
    }

    async blindSign(
        privateKey: CryptoKey,
        blindMsg: Uint8Array,
        info: Uint8Array,
    ): Promise<Uint8Array> {
        const { jwkKey, modulusLengthBytes: kLen } = await this.extractKeyParams(
            privateKey,
            'private',
        );
        if (!jwkKey.n || !jwkKey.d) {
            throw new Error('key has invalid parameters');
        }
        const n = sjcl.bn.fromBits(sjcl.codec.base64url.toBits(jwkKey.n));
        const d = sjcl.bn.fromBits(sjcl.codec.base64url.toBits(jwkKey.d));
        const e = sjcl.bn.fromBits(sjcl.codec.base64url.toBits(jwkKey.e));
        const p = sjcl.bn.fromBits(sjcl.codec.base64url.toBits(jwkKey.p));
        const q = sjcl.bn.fromBits(sjcl.codec.base64url.toBits(jwkKey.q));
        const sk: BigSecretKey = { n, d, p, q };
        const pk: BigPublicKey = { n, e };

        // 1. m = bytes_to_int(blinded_msg)
        const m = os2ip(blindMsg);

        // 2. sk_derived, pk_derived = DeriveKeyPair(sk, info)
        const { secretKey: sk_derived, publicKey: pk_derived } = await this.deriveKeyPair(sk, info);

        // 3. s = RSASP1(sk_derived, m)
        const s = rsasp1(sk_derived, m);

        // 4. m' = RSAVP1(pk_derived, s)
        const mp = rsavp1(pk_derived, s);

        // 5. If m != m', raise "signing failure" and stop
        if (m.equals(mp) === false) {
            throw new Error('signing failure');
        }

        // 6. blind_sig = int_to_bytes(s, kLen)
        // 7. output blind_sig
        return i2osp(s, kLen);
    }

    async finalize(
        publicKey: CryptoKey,
        msg: Uint8Array,
        info: Uint8Array,
        blindSig: Uint8Array,
        inv: Uint8Array,
    ): Promise<Uint8Array> {
        const { jwkKey, modulusLengthBytes: kLen } = await this.extractKeyParams(
            publicKey,
            'public',
        );
        if (!jwkKey.n) {
            throw new Error('key has invalid parameters');
        }
        const e = sjcl.bn.fromBits(sjcl.codec.base64url.toBits(jwkKey.e));
        const n = sjcl.bn.fromBits(sjcl.codec.base64url.toBits(jwkKey.n));
        const pk: BigPublicKey = { e, n };

        // 0. If len(inv) != kLen, raise "unexpected input size" and stop
        //    rInv = bytes_to_int(inv)
        if (inv.length != kLen) {
            throw new Error('unexpected input size');
        }
        const rInv = os2ip(inv);

        // 1. If len(blind_sig) != kLen, raise "unexpected input size" and stop
        if (blindSig.length != kLen) {
            throw new Error('unexpected input size');
        }

        // 2. z = bytes_to_int(blind_sig)
        const z = os2ip(blindSig);

        // 3. s = z * inv mod n
        const s = z.mulmod(rInv, n);

        // 4. sig = int_to_bytes(s, kLen)
        const sig = i2osp(s, kLen);

        // 5. msg_prime = concat("msg", int_to_bytes(len(info), 4), info, msg)
        const msg_prime = joinAll([
            new TextEncoder().encode('msg'),
            int_to_bytes(info.length, 4),
            info,
            msg,
        ]);

        // 6. pk_derived = DerivePublicKey(pk, info)
        const pk_derived = await this.derivePublicKey(pk, info);
        const pk_derived_key = await crypto.subtle.importKey(
            'jwk',
            { e: pk_derived.e.toString(), n: pk_derived.n.toString() },
            { name: PartiallyBlindRSA.NAME, hash: this.params.hash },
            false,
            ['verify'],
        );

        // 7. result = RSASSA-PSS-VERIFY(pk, msg, sig)
        // 8. If result = "valid signature", output sig, else
        //    raise "invalid signature" and stop
        const algorithm = { name: PartiallyBlindRSA.NAME, saltLength: this.params.saltLength };
        if (!(await crypto.subtle.verify(algorithm, pk_derived_key, sig, msg_prime))) {
            throw new Error('invalid signature');
        }

        return sig;
    }

    static generateKey(
        algorithm: Pick<RsaHashedKeyGenParams, 'modulusLength' | 'publicExponent' | 'hash'>,
    ): Promise<CryptoKeyPair> {
        throw new Error('not implemented');
    }

    generateKey(
        algorithm: Pick<RsaHashedKeyGenParams, 'modulusLength' | 'publicExponent'>,
    ): Promise<CryptoKeyPair> {
        return PartiallyBlindRSA.generateKey({ ...algorithm, hash: this.params.hash });
    }

    async verify(
        publicKey: CryptoKey,
        signature: Uint8Array,
        message: Uint8Array,
        info: Uint8Array,
    ): Promise<boolean> {
        const { jwkKey } = await this.extractKeyParams(publicKey, 'public');
        if (!jwkKey.n) {
            throw new Error('key has invalid parameters');
        }
        const e = sjcl.bn.fromBits(sjcl.codec.base64url.toBits(jwkKey.e));
        const n = sjcl.bn.fromBits(sjcl.codec.base64url.toBits(jwkKey.n));
        const pk: BigPublicKey = { e, n };

        // 1. Compute pk_derived = DerivePublicKey(pk, info).
        const pk_derived = await this.derivePublicKey(pk, info);
        const pk_derived_key = await crypto.subtle.importKey(
            'jwk',
            { e: pk_derived.e.toString(), n: pk_derived.n.toString() },
            { name: PartiallyBlindRSA.NAME, hash: this.params.hash },
            false,
            ['verify'],
        );

        // 2. Compute msg_prime = concat("msg", int_to_bytes(len(info), 4), info, msg).
        const msg_prime = joinAll([
            new TextEncoder().encode('msg'),
            int_to_bytes(info.length, 4),
            info,
            message,
        ]);

        // 3. Invoke and output the result of RSASSA-PSS-VERIFY (Section 8.1.2 of [RFC8017]) with (n, e) as pk_derived, M as msg_prime, and S as sig.
        return crypto.subtle.verify(
            { name: PartiallyBlindRSA.NAME, saltLength: this.params.saltLength },
            pk_derived_key,
            signature,
            msg_prime,
        );
    }

    private async derivePublicKey({ n }: BigPublicKey, info: Uint8Array): Promise<BigPublicKey> {
        // 1. hkdf_input = concat("key", info, 0x00)
        // 2. hkdf_salt = int_to_bytes(n, modulus_len)
        // 3. lambda_len = modulus_len / 2
        // 4. hkdf_len = lambda_len + 16
        const hkdf_input = joinAll([new TextEncoder().encode('key'), info, new Uint8Array([0x00])]);
        const hkdf_salt = i2osp(n, n.bitLength() / 8);
        const lambda_len = n.bitLength() / 8 / 2;
        const hkdf_len = lambda_len + 16;

        // 5. expanded_bytes = HKDF(IKM=hkdf_input, salt=hkdf_salt, info="PBRSA", L=hkdf_len)
        const expanded_bytes = new Uint8Array(
            await crypto.subtle.deriveBits(
                {
                    name: 'HKDF',
                    hash: this.params.hash,
                    info: new TextEncoder().encode('PBRSA'),
                    salt: hkdf_salt,
                },
                await crypto.subtle.importKey('raw', hkdf_input, 'HKDF', false, ['deriveBits']),
                hkdf_len * 8,
            ),
        );

        // 6. expanded_bytes[0] &= 0x3F // Clear two-most top bits
        // 7. expanded_bytes[lambda_len-1] |= 0x01 // Set bottom-most bit
        expanded_bytes[0] &= 0x3f;
        expanded_bytes[lambda_len - 1] |= 0x01;

        // 8. e' = bytes_to_int(slice(expanded_bytes, lambda_len))
        // 9. output pk_derived = (n, e')
        const e_prime = os2ip(expanded_bytes.slice(lambda_len));
        return { e: e_prime, n };
    }

    private async deriveKeyPair(sk: BigSecretKey, info: Uint8Array): Promise<BigKeyPair> {
        // phi(N) = (p-1)(q-1)
        const phi = new sjcl.bn(sk.p).sub(1).mul(new sjcl.bn(sk.q).sub(1));

        // 1. (n, e') = DerivePublicKey(n, info)
        const pk_derived = await this.derivePublicKey({ n: sk.n, e: new sjcl.bn(0) }, info);

        // 2. d' = inverse_mod(e', phi)
        const d_prime = pk_derived.e.inverseMod(phi);

        // 3. sk_derived = (n, p, q, phi, d')
        const sk_derived: BigSecretKey = { ...sk, d: d_prime };

        // 4. pk_derived = (n, e')
        return { secretKey: sk_derived, publicKey: pk_derived };
    }
}
