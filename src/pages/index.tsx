import Head from "next/head";
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { prefixLogger } from '@libp2p/logger'
import { multiaddr } from '@multiformats/multiaddr'
// import { MemoryBlockstore } from 'blockstore-core'
// import { MemoryDatastore } from 'datastore-core'
import { createHelia, type HeliaLibp2p } from 'helia'
import { type Blockstore } from 'interface-blockstore'
import { Key, Pair, type Datastore } from 'interface-datastore'
import { IDBDatastore } from 'datastore-idb'
import { IDBBlockstore } from 'blockstore-idb'
import { createLibp2p } from 'libp2p'
// import debug from 'weald'
import type { Libp2p } from '@libp2p/interface'
import { bitswap } from '@helia/block-brokers'
import { ping } from '@libp2p/ping';
import { webRTC, webRTCDirect } from "@libp2p/webrtc";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { webSockets } from "@libp2p/websockets";
import { webTransport } from "@libp2p/webtransport";
import { useCallback, useEffect, useState } from "react";
import { CRDTDatastore, CRDTLibp2pServices, defaultOptions, msgIdFnStrictNoSign, Options, PubSubBroadcaster } from "js-ds-crdt";
import { Box, Button, Container, IconButton, Input } from "@chakra-ui/react";
import * as filters from '@libp2p/websockets/filters'
import { DeleteIcon } from "@chakra-ui/icons";

let isLibp2pInitialized = false;

export default function Home() {
  const [ds, setDs] = useState<CRDTDatastore | null>(null)
  const [remoteMultiaddr, setRemoteMultiaddr] = useState('')
  const [dsKey, setDsKey] = useState('')
  const [dsValue, setDsValue] = useState('')
  const [dsGetKey, setDsGetKey] = useState('')
  const [dsGetValue, setDsGetValue] = useState('')
  const [dsList, setDsList] = useState<Pair[]>([])

  async function newCRDTDatastore(topic: string = 'test', datastore: Datastore, blockstore: Blockstore, options?: Partial<Options>): Promise<CRDTDatastore> {
    const store = datastore
    const namespace = new Key('/test')
    const dagService = await createNode(datastore, blockstore)
    const broadcaster = new PubSubBroadcaster(dagService.libp2p, topic, prefixLogger('crdt').forComponent('pubsub'))

    let opts
    if (options !== undefined) {
      opts = { ...defaultOptions(), ...options }
    } else {
      opts = defaultOptions()
    }

    return new CRDTDatastore(store, namespace, dagService, broadcaster, opts)
  }

  async function createNode(datastore: Datastore, blockstore: Blockstore): Promise<HeliaLibp2p<Libp2p<CRDTLibp2pServices>>> {
    const libp2p = await createLibp2p({
      addresses: {
        listen: [
          `/webrtc`,
        ]
      },
      transports: [
        webTransport(),
        webSockets({
          // connect to all sockets, even insecure ones
          filter: filters.all
        }),
        webRTC(),
        webRTCDirect(),
        circuitRelayTransport({
          discoverRelays: 0,
        }),

      ],
      connectionEncryption: [
        noise()
      ],
      streamMuxers: [
        yamux()
      ],
      connectionGater: {
        denyDialMultiaddr: async () => false,
      },
      connectionMonitor: {
        // reenable after https://github.com/libp2p/js-libp2p/pull/2671
        enabled: false,
      },
      connectionManager: {
        minConnections: 1
      },
      services: {
        identify: identify(),
        pubsub: gossipsub({
          emitSelf: false,
          allowPublishToZeroTopicPeers: true,
          msgIdFn: msgIdFnStrictNoSign,
          ignoreDuplicatePublishError: true,
          tagMeshPeers: true
        }),
        ping: ping()
      }
    })

    const blockBrokers = [bitswap()]

    const h = await createHelia({
      datastore,
      blockstore,
      libp2p,
      blockBrokers,
      dns: undefined
    })

    return h
  }

  const updateDsList = useCallback(async () => {
    const kv = await ds?.query({});
    if (kv !== undefined && kv !== null) {
      setDsList(kv);
    }
  }, [ds]);

  async function setup() {
    const blockstore = new IDBBlockstore('crdt/bs')
    await blockstore.open()

    const datastore = new IDBDatastore('crdt/ds')
    await datastore.open()

    // const datastore = new MemoryDatastore()
    // const blockstore = new MemoryBlockstore()

    const opts: Partial<Options> = {
      putHook: (key: string, value: Uint8Array) => {
        const k = new Key(key)
        console.log(`Added: [${k.toString()}] -> ${new TextDecoder().decode(value)}`)
        const event = new CustomEvent('dsupdate', { detail: k.toString() });
        document.dispatchEvent(event);
      },
      deleteHook: (key: string) => {
        const k = new Key(key)
        console.log(`Removed: [${k.toString()}]`)
        const event = new CustomEvent('dsupdate', { detail: k.toString() });
        document.dispatchEvent(event);
      },
      loggerPrefix: 'crdt'
    }

    const crdtDS = await newCRDTDatastore('globaldb-example', datastore, blockstore, opts)
    setDs(crdtDS)
  }

  const handleMAChange = (event: any) => {
    setRemoteMultiaddr(event.target.value)
  }

  const handleConnect = async () => {
    try {
      const conn = await ds?.dagService.libp2p.dial(multiaddr(remoteMultiaddr))
      console.log(conn)
    } catch (e) {
      console.log(e)
    }
  }

  const handleKeyChange = (event: any) => {
    setDsKey(event.target.value)
  }

  const handleValueChange = (event: any) => {
    setDsValue(event.target.value)
  }

  const handlePut = async () => {
    const v = new TextEncoder().encode(dsValue)
    await ds?.put(new Key(dsKey), v)
    updateDsList()
  }

  const handleGetKeyChange = (event: any) => {
    setDsGetKey(event.target.value)
  }

  const handleGet = async () => {
    const v = await ds?.get(new Key(dsGetKey))
    if (v !== undefined && v !== null) {
      setDsGetValue(new TextDecoder().decode(v))
    }
  }

  const handleDelete = async () => {
    await ds?.delete(new Key(dsGetKey))
  }

  const handleDeleteBin = async (key: string) => {
    await ds?.delete(new Key(key))
  }

  const handleList = async () => {
    await updateDsList()
  }

  useEffect(() => {
    const init = async () => {
      if (!isLibp2pInitialized) {
        await setup();
        isLibp2pInitialized = true;
      }
    };

    init();
  }, []);

  useEffect(() => {
    const init = async () => {
      await updateDsList()
    }

    init()
  }, []);

  useEffect(() => {
    const evtProcessor = async (e: any) => {
      console.log('evt', e)

      // Add a 200ms delay before running updateDsList
      // to allow bitswap to get the data
      setTimeout(async () => {
        await updateDsList()
      }, 200)
    }

    document.addEventListener('dsupdate', evtProcessor)

    return () => {
      document.removeEventListener('dsupdate', evtProcessor)
    }
  }, [updateDsList])

  return (
    <>
      <Head>
        <title>Create Next App</title>
        <meta name="description" content="Generated by create next app" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </Head>
      <main>
        {ds?.dagService.libp2p.peerId.toString()}
        <Container>
          <Box>
            <Input
              value={remoteMultiaddr}
              onChange={handleMAChange}
              placeholder="Multiaddr"
            />
            <Button onClick={handleConnect}>Connect</Button>
          </Box>
          <Box>
            Key: <Input value={dsKey}
              onChange={handleKeyChange} />
            Value: <Input value={dsValue}
              onChange={handleValueChange} />
            <Button onClick={handlePut}>Put</Button>
          </Box>
          <Box>
            Key: <Input value={dsGetKey}
              onChange={handleGetKeyChange} />
            <Button onClick={handleGet}>Get</Button>
            <Button onClick={handleDelete}>Delete</Button>
            <Box>
              Value: {dsGetValue}
            </Box>
          </Box>
          <Box>
            <Button onClick={handleList}>List</Button>
            <Box>
              {dsList.map((pair, index) => (
                <Box key={index}>
                  <IconButton onClick={() => handleDeleteBin(pair.key.toString())} aria-label='Delete' icon={<DeleteIcon />} />
                  {pair.key.toString()} : {new TextDecoder().decode(pair.value)}
                </Box>
              ))}
            </Box>
          </Box>
        </Container>
      </main>
    </>
  );
}
