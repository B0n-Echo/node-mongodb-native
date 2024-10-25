import { EJSON, UUID } from 'bson';
import { expect } from 'chai';
import * as crypto from 'crypto';
import * as sinon from 'sinon';

// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { ClientEncryption } from '../../../src/client-side-encryption/client_encryption';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { StateMachine } from '../../../src/client-side-encryption/state_machine';
import {
  type Collection,
  type CommandStartedEvent,
  Connection,
  CSOTTimeoutContext,
  type KMSProviders,
  type MongoClient,
  MongoOperationTimeoutError
} from '../../mongodb';
import * as BSON from '../../mongodb';
import { type FailPoint, getEncryptExtraOptions, measureDuration, sleep } from '../../tools/utils';

const metadata = {
  requires: {
    mongodb: '>=4.2.0',
    clientSideEncryption: true
  }
};

describe('Client Side Encryption Functional', function () {
  const dataDbName = 'db';
  const dataCollName = 'coll';
  const keyVaultDbName = 'keyvault';
  const keyVaultCollName = 'datakeys';
  const keyVaultNamespace = `${keyVaultDbName}.${keyVaultCollName}`;

  it('CSFLE_KMS_PROVIDERS should be valid EJSON', function () {
    const CSFLE_KMS_PROVIDERS = process.env.CSFLE_KMS_PROVIDERS;
    if (typeof CSFLE_KMS_PROVIDERS === 'string') {
      /**
       * The shape of CSFLE_KMS_PROVIDERS is as follows:
       *
       * ```ts
       * interface CSFLE_kms_providers {
       *    aws: {
       *      accessKeyId: string;
       *      secretAccessKey: string;
       *   };
       *   azure: {
       *     tenantId: string;
       *     clientId: string;
       *     clientSecret: string;
       *   };
       *   gcp: {
       *     email: string;
       *     privateKey: string;
       *   };
       *   local: {
       *     // EJSON handle converting this, its actually the canonical -> { $binary: { base64: string; subType: string } }
       *     // **NOTE**: The dollar sign has to be escaped when using this as an ENV variable
       *     key: Binary;
       *   }
       * }
       * ```
       */
      expect(() => EJSON.parse(CSFLE_KMS_PROVIDERS)).to.not.throw(SyntaxError);
    } else {
      this.skip();
    }
  });

  describe('Collection', metadata, function () {
    describe('#bulkWrite()', metadata, function () {
      context('when encryption errors', function () {
        let client: MongoClient;

        beforeEach(function () {
          client = this.configuration.newClient(
            {},
            {
              autoEncryption: {
                keyVaultNamespace: 'test.keyvault',
                kmsProviders: {
                  local: {
                    key: 'A'.repeat(128)
                  }
                },
                extraOptions: getEncryptExtraOptions(),
                encryptedFieldsMap: {
                  'test.coll': {
                    fields: [
                      {
                        path: 'ssn',
                        keyId: new UUID('23f786b4-1d39-4c36-ae88-70a663321ec9').toBinary(),
                        bsonType: 'string'
                      }
                    ]
                  }
                }
              }
            }
          );
        });

        afterEach(async function () {
          await client.close();
        });

        it('bubbles up the error', metadata, async function () {
          try {
            await client
              .db('test')
              .collection('coll')
              // @ts-expect-error: Incorrectly formatted bulkWrite to test error case
              .bulkWrite([{ insertOne: { ssn: 'foo' } }]);
            expect.fail('expected error to be thrown');
          } catch (error) {
            expect(error.name).to.equal('MongoBulkWriteError');
          }
        });
      });
    });
  });

  describe('BSON Options', function () {
    let client: MongoClient;
    let encryptedClient: MongoClient;

    beforeEach(async function () {
      client = this.configuration.newClient();

      const encryptSchema = (keyId: unknown, bsonType: string) => ({
        encrypt: {
          bsonType,
          algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Random',
          keyId: [keyId]
        }
      });

      const kmsProviders = this.configuration.kmsProviders(crypto.randomBytes(96));

      await client.connect();

      const encryption = new ClientEncryption(client, {
        bson: BSON,
        keyVaultNamespace,
        kmsProviders,
        extraOptions: getEncryptExtraOptions()
      });

      const dataDb = client.db(dataDbName);
      const keyVaultDb = client.db(keyVaultDbName);

      await dataDb.dropCollection(dataCollName).catch(() => null);
      await keyVaultDb.dropCollection(keyVaultCollName).catch(() => null);
      await keyVaultDb.createCollection(keyVaultCollName);
      const dataKey = await encryption.createDataKey('local');

      const $jsonSchema = {
        bsonType: 'object',
        properties: {
          a: encryptSchema(dataKey, 'int'),
          b: encryptSchema(dataKey, 'int'),
          c: encryptSchema(dataKey, 'long'),
          d: encryptSchema(dataKey, 'double')
        }
      };

      await dataDb.createCollection(dataCollName, {
        validator: { $jsonSchema }
      });

      encryptedClient = this.configuration.newClient(
        {},
        {
          autoEncryption: {
            keyVaultNamespace,
            kmsProviders,
            extraOptions: getEncryptExtraOptions()
          }
        }
      );

      await encryptedClient.connect();
    });

    afterEach(function () {
      return Promise.resolve()
        .then(() => encryptedClient?.close())
        .then(() => client?.close());
    });

    const testCases = [
      {},
      { promoteValues: true },
      { promoteValues: false },
      { promoteValues: true, promoteLongs: false },
      { promoteValues: true, promoteLongs: true },
      { bsonRegExp: true },
      { ignoreUndefined: true }
    ];

    for (const bsonOptions of testCases) {
      const name = `should respect bson options ${JSON.stringify(bsonOptions)}`;

      it(name, metadata, async function () {
        const data = {
          _id: new BSON.ObjectId(),
          a: 12,
          b: new BSON.Int32(12),
          c: new BSON.Long(12),
          d: new BSON.Double(12),
          e: /[A-Za-z0-9]*/,
          f: new BSON.BSONRegExp('[A-Za-z0-9]*'),
          g: undefined
        };

        const expected = BSON.deserialize(BSON.serialize(data, bsonOptions), bsonOptions);

        const coll = encryptedClient.db(dataDbName).collection(dataCollName);
        const result = await coll.insertOne(data, bsonOptions);
        const actual = await coll.findOne({ _id: result.insertedId }, bsonOptions);
        const gValue = actual?.g;
        delete actual?.g;

        expect(actual).to.deep.equal(expected);
        expect(gValue).to.equal(bsonOptions.ignoreUndefined ? data.g : null);
      });
    }
  });

  describe('key order aware command properties', () => {
    let client: MongoClient;
    let collection: Collection;

    beforeEach(async function () {
      if (!this.configuration.clientSideEncryption.enabled) {
        return;
      }

      const encryptionOptions = {
        monitorCommands: true,
        autoEncryption: {
          keyVaultNamespace,
          kmsProviders: { local: { key: 'A'.repeat(128) } },
          extraOptions: getEncryptExtraOptions()
        }
      };
      client = this.configuration.newClient({}, encryptionOptions);
      collection = client.db(dataDbName).collection('keyOrder');
    });

    afterEach(async () => {
      if (client) await client.close();
    });

    describe('find', () => {
      it('should maintain ordered sort', metadata, async function () {
        const events: CommandStartedEvent[] = [];
        client.on('commandStarted', ev => events.push(ev));
        const sort = Object.freeze([
          Object.freeze(['1', 1] as const),
          Object.freeze(['0', 1] as const)
        ]);
        // @ts-expect-error: Our findOne API does not accept readonly input
        await collection.findOne({}, { sort });
        const findEvent = events.find(event => !!event.command.find);
        expect(findEvent).to.have.property('commandName', 'find');
        expect(findEvent).to.have.nested.property('command.sort').deep.equal(new Map(sort));
      });
    });

    describe('findAndModify', () => {
      it('should maintain ordered sort', metadata, async function () {
        const events: CommandStartedEvent[] = [];
        client.on('commandStarted', ev => events.push(ev));
        const sort = Object.freeze([
          Object.freeze(['1', 1] as const),
          Object.freeze(['0', 1] as const)
        ]);
        // @ts-expect-error: Our findOneAndUpdate API does not accept readonly input
        await collection.findOneAndUpdate({}, { $setOnInsert: { a: 1 } }, { sort });
        const findAndModifyEvent = events.find(event => !!event.command.findAndModify);
        expect(findAndModifyEvent).to.have.property('commandName', 'findAndModify');
        expect(findAndModifyEvent)
          .to.have.nested.property('command.sort')
          .deep.equal(new Map(sort));
      });
    });

    describe('createIndexes', () => {
      it('should maintain ordered index keys', metadata, async function () {
        const events: CommandStartedEvent[] = [];
        client.on('commandStarted', ev => events.push(ev));
        const indexDescription = Object.freeze([
          Object.freeze(['1', 1] as const),
          Object.freeze(['0', 1] as const)
        ]);
        // @ts-expect-error: Our createIndex API does not accept readonly input
        await collection.createIndex(indexDescription, { name: 'myIndex' });
        const createIndexEvent = events.find(event => !!event.command.createIndexes);
        expect(createIndexEvent).to.have.property('commandName', 'createIndexes');
        expect(createIndexEvent).to.have.nested.property('command.indexes').that.has.lengthOf(1);
        const index = createIndexEvent?.command.indexes[0];
        expect(index.key).to.deep.equal(new Map(indexDescription));
      });
    });
  });

  describe(
    'when @@mdb.decorateDecryptionResult is set on autoEncrypter',
    { requires: { clientSideEncryption: true, mongodb: '>=4.4' } },
    () => {
      let client: MongoClient;
      let encryptedClient: MongoClient;

      beforeEach(async function () {
        client = this.configuration.newClient();

        const encryptSchema = (keyId: unknown, bsonType: string) => ({
          encrypt: {
            bsonType,
            algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Random',
            keyId: [keyId]
          }
        });

        const kmsProviders = this.configuration.kmsProviders(crypto.randomBytes(96));

        await client.connect();

        const encryption = new ClientEncryption(client, {
          keyVaultNamespace,
          kmsProviders,
          extraOptions: getEncryptExtraOptions()
        });

        const dataDb = client.db(dataDbName);
        const keyVaultDb = client.db(keyVaultDbName);

        await dataDb.dropCollection(dataCollName).catch(() => null);
        await keyVaultDb.dropCollection(keyVaultCollName).catch(() => null);
        await keyVaultDb.createCollection(keyVaultCollName);
        const dataKey = await encryption.createDataKey('local');

        const $jsonSchema = {
          bsonType: 'object',
          properties: {
            a: encryptSchema(dataKey, 'int'),
            b: encryptSchema(dataKey, 'string'),
            c: {
              bsonType: 'object',
              properties: {
                d: {
                  encrypt: {
                    keyId: [dataKey],
                    algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Deterministic',
                    bsonType: 'string'
                  }
                }
              }
            }
          }
        };

        await dataDb.createCollection(dataCollName, {
          validator: { $jsonSchema }
        });

        encryptedClient = this.configuration.newClient(
          {},
          {
            autoEncryption: {
              keyVaultNamespace,
              kmsProviders,
              extraOptions: getEncryptExtraOptions()
            }
          }
        );

        encryptedClient.autoEncrypter[Symbol.for('@@mdb.decorateDecryptionResult')] = true;
        await encryptedClient.connect();
      });

      afterEach(async function () {
        await encryptedClient?.close();
        await client?.close();
      });

      it('adds decrypted keys to result at @@mdb.decryptedKeys', async function () {
        const coll = encryptedClient.db(dataDbName).collection(dataCollName);

        const data = {
          _id: new BSON.ObjectId(),
          a: 1,
          b: 'abc',
          c: { d: 'def' }
        };

        const result = await coll.insertOne(data);
        const decrypted = await coll.findOne({ _id: result.insertedId });

        expect(decrypted).to.deep.equal(data);
        expect(decrypted)
          .to.have.property(Symbol.for('@@mdb.decryptedKeys'))
          .that.deep.equals(['a', 'b']);

        // Nested
        expect(decrypted).to.have.property('c');
        expect(decrypted.c)
          .to.have.property(Symbol.for('@@mdb.decryptedKeys'))
          .that.deep.equals(['d']);
      });
    }
  );
});

describe('Range Explicit Encryption with JS native types', function () {
  const metaData: MongoDBMetadataUI = {
    requires: {
      clientSideEncryption: '>=6.1.0',

      // The Range Explicit Encryption tests require MongoDB server 7.0+ for QE v2.
      // The tests must not run against a standalone.
      //
      // `range` is not supported on 8.0+ servers.
      mongodb: '>=8.0.0',
      topology: '!single'
    }
  };

  const getKmsProviders = (): { local: { key: string } } => {
    const result = EJSON.parse(process.env.CSFLE_KMS_PROVIDERS || '{}') as unknown as {
      local: { key: string };
    };

    return { local: result.local };
  };

  let clientEncryption: ClientEncryption;
  let keyId;
  let keyVaultClient;

  beforeEach(async function () {
    keyVaultClient = this.configuration.newClient();
    clientEncryption = new ClientEncryption(keyVaultClient, {
      keyVaultNamespace: 'keyvault.datakeys',
      kmsProviders: getKmsProviders()
    });

    keyId = await clientEncryption.createDataKey('local');
  });

  afterEach(async function () {
    await keyVaultClient.close();
  });

  it('supports a js number for trimFactor', metaData, async function () {
    await clientEncryption.encrypt(new BSON.Int32(123), {
      keyId,
      algorithm: 'Range',
      contentionFactor: 0,
      rangeOptions: {
        min: 0,
        max: 1000,
        trimFactor: 1,
        sparsity: new BSON.Long(1)
      }
    });
  });

  it('supports a bigint for sparsity', metaData, async function () {
    await clientEncryption.encrypt(new BSON.Int32(123), {
      keyId,
      algorithm: 'Range',
      contentionFactor: 0,
      rangeOptions: {
        min: 0,
        max: 1000,
        trimFactor: new BSON.Int32(1),
        sparsity: 1n
      }
    });
  });
});

describe('CSOT', function () {
  describe('Auto encryption', function () {
    let setupClient;
    let keyVaultClient: MongoClient;
    let dataKey;

    beforeEach(async function () {
      keyVaultClient = this.configuration.newClient();
      await keyVaultClient.connect();
      await keyVaultClient.db('keyvault').collection('datakeys');
      const clientEncryption = new ClientEncryption(keyVaultClient, {
        keyVaultNamespace: 'keyvault.datakeys',
        kmsProviders: getKmsProviders()
      });
      dataKey = await clientEncryption.createDataKey('local');
      setupClient = this.configuration.newClient();
      await setupClient
        .db()
        .admin()
        .command({
          configureFailPoint: 'failCommand',
          mode: 'alwaysOn',
          data: {
            failCommands: ['find'],
            blockConnection: true,
            blockTimeMS: 2000
          }
        } as FailPoint);
    });

    afterEach(async function () {
      await keyVaultClient.close();
      await setupClient
        .db()
        .admin()
        .command({
          configureFailPoint: 'failCommand',
          mode: 'off'
        } as FailPoint);
      await setupClient.close();
    });

    const getKmsProviders = (): KMSProviders => {
      const result = EJSON.parse(process.env.CSFLE_KMS_PROVIDERS || '{}') as unknown as {
        local: unknown;
      };

      return { local: result.local };
    };

    const metadata: MongoDBMetadataUI = {
      requires: {
        mongodb: '>=4.2.0',
        clientSideEncryption: true
      }
    };

    context(
      'when an auto encrypted client is configured with timeoutMS and auto encryption takes longer than timeoutMS',
      function () {
        let encryptedClient: MongoClient;
        const timeoutMS = 1000;

        beforeEach(async function () {
          encryptedClient = this.configuration.newClient(
            {},
            {
              autoEncryption: {
                keyVaultClient,
                keyVaultNamespace: 'keyvault.datakeys',
                kmsProviders: getKmsProviders(),
                schemaMap: {
                  'test.test': {
                    bsonType: 'object',
                    encryptMetadata: {
                      keyId: [new UUID(dataKey)]
                    },
                    properties: {
                      a: {
                        encrypt: {
                          bsonType: 'int',
                          algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Random',
                          keyId: [new UUID(dataKey)]
                        }
                      }
                    }
                  }
                }
              },
              timeoutMS
            }
          );
          await encryptedClient.connect();
        });

        afterEach(async function () {
          await encryptedClient.close();
        });

        it('the command should fail due to a timeout error', metadata, async function () {
          const { duration, result: error } = await measureDuration(() =>
            encryptedClient
              .db('test')
              .collection('test')
              .insertOne({ a: 1 })
              .catch(e => e)
          );
          expect(error).to.be.instanceOf(MongoOperationTimeoutError);
          expect(duration).to.be.within(timeoutMS - 100, timeoutMS + 100);
        });
      }
    );

    context(
      'when an auto encrypted client is not configured with timeoutMS and auto encryption is delayed',
      function () {
        let encryptedClient: MongoClient;
        beforeEach(async function () {
          encryptedClient = this.configuration.newClient(
            {},
            {
              autoEncryption: {
                keyVaultClient,
                keyVaultNamespace: 'admin.datakeys',
                kmsProviders: getKmsProviders()
              }
            }
          );
        });

        afterEach(async function () {
          await encryptedClient.close();
        });

        it('the command succeeds', metadata, async function () {
          await encryptedClient.db('test').collection('test').aggregate([]).toArray();
        });
      }
    );
  });

  describe('State machine', function () {
    const stateMachine = new StateMachine({} as any);

    const timeoutContext = () => {
      return new CSOTTimeoutContext({
        timeoutMS: 1000,
        serverSelectionTimeoutMS: 30000
      });
    };

    const timeoutMS = 1000;

    const metadata: MongoDBMetadataUI = {
      requires: {
        mongodb: '>=4.2.0'
      }
    };

    describe('#markCommand', function () {
      context(
        'when csot is enabled and markCommand() takes longer than the remaining timeoutMS',
        function () {
          let encryptedClient: MongoClient;

          beforeEach(async function () {
            encryptedClient = this.configuration.newClient(
              {},
              {
                timeoutMS
              }
            );
            await encryptedClient.connect();

            const stub = sinon
              // @ts-expect-error accessing private method
              .stub(Connection.prototype, 'sendCommand')
              .callsFake(async function* (...args) {
                await sleep(1000);
                yield* stub.wrappedMethod.call(this, ...args);
              });
          });

          afterEach(async function () {
            await encryptedClient?.close();
            sinon.restore();
          });

          it('the command should fail due to a timeout error', metadata, async function () {
            const { duration, result: error } = await measureDuration(() =>
              stateMachine
                .markCommand(
                  encryptedClient,
                  'test.test',
                  BSON.serialize({ ping: 1 }),
                  timeoutContext()
                )
                .catch(e => e)
            );
            expect(error).to.be.instanceOf(MongoOperationTimeoutError);
            expect(duration).to.be.within(timeoutMS - 100, timeoutMS + 100);
          });
        }
      );
    });

    describe('#fetchKeys', function () {
      let setupClient;

      beforeEach(async function () {
        setupClient = this.configuration.newClient();
        await setupClient
          .db()
          .admin()
          .command({
            configureFailPoint: 'failCommand',
            mode: 'alwaysOn',
            data: {
              failCommands: ['find'],
              blockConnection: true,
              blockTimeMS: 2000
            }
          } as FailPoint);
      });

      afterEach(async function () {
        await setupClient
          .db()
          .admin()
          .command({
            configureFailPoint: 'failCommand',
            mode: 'off'
          } as FailPoint);
        await setupClient.close();
      });

      context(
        'when csot is enabled and fetchKeys() takes longer than the remaining timeoutMS',
        function () {
          let encryptedClient;

          beforeEach(async function () {
            encryptedClient = this.configuration.newClient(
              {},
              {
                timeoutMS
              }
            );
            await encryptedClient.connect();
          });

          afterEach(async function () {
            await encryptedClient?.close();
          });

          it('the command should fail due to a timeout error', metadata, async function () {
            const { duration, result: error } = await measureDuration(() =>
              stateMachine
                .fetchKeys(encryptedClient, 'test.test', BSON.serialize({ a: 1 }), timeoutContext())
                .catch(e => e)
            );
            expect(error).to.be.instanceOf(MongoOperationTimeoutError);
            expect(duration).to.be.within(timeoutMS - 100, timeoutMS + 100);
          });
        }
      );

      context('when csot is not enabled and fetchKeys() is delayed', function () {
        let encryptedClient;

        beforeEach(async function () {
          encryptedClient = this.configuration.newClient();
          await encryptedClient.connect();
        });

        afterEach(async function () {
          await encryptedClient?.close();
        });

        it('the command succeeds', metadata, async function () {
          await stateMachine.fetchKeys(encryptedClient, 'test.test', BSON.serialize({ a: 1 }));
        });
      });
    });

    describe('#fetchCollectionInfo', function () {
      let setupClient;

      beforeEach(async function () {
        setupClient = this.configuration.newClient();
        await setupClient
          .db()
          .admin()
          .command({
            configureFailPoint: 'failCommand',
            mode: 'alwaysOn',
            data: {
              failCommands: ['listCollections'],
              blockConnection: true,
              blockTimeMS: 2000
            }
          } as FailPoint);
      });

      afterEach(async function () {
        await setupClient
          .db()
          .admin()
          .command({
            configureFailPoint: 'failCommand',
            mode: 'off'
          } as FailPoint);
        await setupClient.close();
      });

      context(
        'when csot is enabled and fetchCollectionInfo() takes longer than the remaining timeoutMS',
        metadata,
        function () {
          let encryptedClient: MongoClient;

          beforeEach(async function () {
            encryptedClient = this.configuration.newClient(
              {},
              {
                timeoutMS
              }
            );
            await encryptedClient.connect();
          });

          afterEach(async function () {
            await encryptedClient?.close();
          });

          it('the command should fail due to a timeout error', metadata, async function () {
            const { duration, result: error } = await measureDuration(() =>
              stateMachine
                .fetchCollectionInfo(encryptedClient, 'test.test', { a: 1 }, timeoutContext())
                .catch(e => e)
            );
            expect(error).to.be.instanceOf(MongoOperationTimeoutError);
            expect(duration).to.be.within(timeoutMS - 100, timeoutMS + 100);
          });
        }
      );

      context(
        'when csot is not enabled and fetchCollectionInfo() is delayed',
        metadata,
        function () {
          let encryptedClient: MongoClient;

          beforeEach(async function () {
            encryptedClient = this.configuration.newClient();
            await encryptedClient.connect();
          });

          afterEach(async function () {
            await encryptedClient?.close();
          });

          it('the command succeeds', metadata, async function () {
            await stateMachine.fetchCollectionInfo(encryptedClient, 'test.test', { a: 1 });
          });
        }
      );
    });
  });
});
