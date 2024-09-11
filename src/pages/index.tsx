import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { DeleteIcon, ExternalLinkIcon } from "@chakra-ui/icons";
import { Box, Button, Container, IconButton, Input, ListItem, UnorderedList, Heading, Flex, Textarea, Text, Center, Link } from "@chakra-ui/react";
import { bitswap } from '@helia/block-brokers'
import {
  createDelegatedRoutingV1HttpApiClient,
  DelegatedRoutingV1HttpApiClient,
} from '@helia/delegated-routing-v1-http-api-client'
import { Strings, strings } from '@helia/strings'
import { bootstrap } from '@libp2p/bootstrap'
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { identify } from '@libp2p/identify'
import type { Connection, Libp2p, PeerId } from '@libp2p/interface'
import { kadDHT } from "@libp2p/kad-dht";
import { prefixLogger } from '@libp2p/logger'
import { peerIdFromString } from '@libp2p/peer-id'
import { ping } from '@libp2p/ping';
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery'
import { webRTC, webRTCDirect } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import * as filters from '@libp2p/websockets/filters'
import { webTransport } from "@libp2p/webtransport";
import { Multiaddr, multiaddr } from '@multiformats/multiaddr'
import { instance } from "@viz-js/viz";
import { IDBBlockstore } from 'blockstore-idb'
import { IDBDatastore } from 'datastore-idb'
import { createHelia, type HeliaLibp2p } from 'helia'
import { type Blockstore } from 'interface-blockstore'
import { Key, Pair, type Datastore } from 'interface-datastore'
import first from 'it-first'
import { CRDTDatastore, CRDTLibp2pServices, defaultOptions, Heads, msgIdFnStrictNoSign, Options, PubSubBroadcaster } from "js-ds-crdt";
import { createLibp2p } from 'libp2p'
import { isEqual } from 'lodash'
import { debounce } from 'lodash';
import { CID } from "multiformats";
import Head from "next/head";
import { useCallback, useEffect, useRef, useState } from "react";
import React from "react";

// import debug from 'weald'

let isLibp2pInitialized = false;

const bootstrappers = [
  process.env.NEXT_PUBLIC_BOOTSTRAPPER_1,
  process.env.NEXT_PUBLIC_BOOTSTRAPPER_2,
]

const topic = process.env.NEXT_PUBLIC_TOPIC
const dhtPrefix = process.env.NEXT_PUBLIC_DHT_PREFIX
const delegatedRouterUrl = process.env.NEXT_PUBLIC_DELEGATED_ROUTER

const textareaKey = '/textarea1'
const caTextareaKey = '/catextarea1'

export default function Home() {
  const graphRef = useRef(null);

  const [ds, setDs] = useState<CRDTDatastore | null>(null)
  const [heads, setHeads] = useState<CID[] | undefined>(undefined)
  const [height, setHeight] = useState<bigint | undefined>(undefined)
  const [queuedJobs, setQueuedJobs] = useState<number>(0)
  const [isDirty, setIsDirty] = useState<boolean>(false)
  const [stringEncoder, setStringEncoder] = useState<Strings | undefined>(undefined)
  const [graph, setGraph] = useState<string>('')
  const [error, setError] = useState<any>(null);

  const [dsKey, setDsKey] = useState('')
  const [dsValue, setDsValue] = useState('')
  const [dsList, setDsList] = useState<Pair[]>([])
  const [textAreaValue, setTextAreaValue] = useState('')
  const [contentAddressedTextAreaValue, setContentAddressedTextAreaValue] = useState('')
  const [history, setHistory] = useState<string[]>([])

  const [isOnline, setIsOnline] = useState(true)
  const [dialable, setDialable] = useState<string[]>([])
  const [connections, setConnections] = useState<Connection[]>([])
  const [peers, setPeers] = useState<PeerId[]>([])
  const [remoteMultiaddr, setRemoteMultiaddr] = useState('')
  const [bootstrapMultiaddrs, setBootstrapMultiaddrs] = useState<Multiaddr[]>([])

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
    const delegatedClient = createDelegatedRoutingV1HttpApiClient(delegatedRouterUrl as string)
    const { bootstrapAddrs, relayListenAddrs } = await getBootstrapMultiaddrs(
      delegatedClient,
    )
    const blockBrokers = [bitswap()]

    let libp2p: Libp2p<CRDTLibp2pServices> | null = null

    try {
      libp2p = await createLibp2p({
        addresses: {
          listen: [
            `/webrtc`,
            ...relayListenAddrs,
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
        peerDiscovery: [
          bootstrap({
            list: bootstrapAddrs
          }),
          pubsubPeerDiscovery({
            interval: 5_000,
            listenOnly: false,
            topics: [`${topic}._peer-discovery._p2p._pubsub`],
          }),

        ],
        streamMuxers: [
          yamux()
        ],
        connectionGater: {
          denyDialMultiaddr: async () => false,
        },
        connectionManager: {
          minConnections: 5,
        },
        services: {
          kadDHT: kadDHT({
            protocol: `/${dhtPrefix}/kad/1.0.0`,
          }),
          delegatedRouting: () => delegatedClient,
          identify: identify(),
          pubsub: gossipsub({
            emitSelf: false,
            allowPublishToZeroTopicPeers: true,
            msgIdFn: msgIdFnStrictNoSign,
            ignoreDuplicatePublishError: true,
            tagMeshPeers: true,
            doPX: true,
          }),
          ping: ping()
        }
      })
    } catch (e: any) {
      setError(e)
      console.log(e)
      throw e
    }

    let helia: HeliaLibp2p<Libp2p<CRDTLibp2pServices>> | null = null

    if (libp2p) {
      try {
        helia = await createHelia({
          datastore,
          blockstore,
          libp2p,
          blockBrokers,
          dns: undefined
        })

        setStringEncoder(strings(helia))
      } catch (e: any) {
        setError(e)
        console.log(e)
        throw e
      }
    }

    if (helia) {
      return helia
    } else {
      throw new Error('no helia')
    }
  }

  const updateDsList = useCallback(async () => {
    const kv = await ds?.query({});
    if (kv !== undefined && kv !== null) {
      setDsList(kv);
    }
  }, [ds]);

  interface BootstrapsMultiaddrs {
    // Multiaddrs that are dialable from the browser
    bootstrapAddrs: string[]

    // multiaddr string representing the circuit relay v2 listen addr
    relayListenAddrs: string[]
  }

  async function getBootstrapMultiaddrs(
    client: DelegatedRoutingV1HttpApiClient,
  ): Promise<BootstrapsMultiaddrs> {
    const peers = await Promise.all(
      bootstrappers.map(async (peerId) => {
        if (peerId) {
          return first(client.getPeers(peerIdFromString(peerId)))
        }
      }),
    )

    const bootstrapAddrs = []
    const relayListenAddrs = []

    for (const p of peers) {
      if (p && p.Addrs.length > 0) {
        for (const maddr of p.Addrs) {
          const protos = maddr.protoNames()

          if (
            ((protos.includes('dns4') || protos.includes('dns6')) &&
              protos.includes('tcp') &&
              protos.includes('ws') &&
              protos.includes('tls')) || // websocket over tls
            (protos.includes('webtransport') && protos.includes('certhash')) || // webtransport
            (protos.includes('webrtc-direct') && protos.includes('certhash')) // webrtc-direct
          ) {
            // TODO skip ipv6 loopback
            if (maddr.nodeAddress().address === '127.0.0.1') {
              continue // skip loopback
            }

            bootstrapAddrs.push(maddr.toString())
            relayListenAddrs.push(getRelayListenAddr(maddr, p.ID))
          }
        }
      }
    }

    setBootstrapMultiaddrs(bootstrapMultiaddrs)

    return { bootstrapAddrs, relayListenAddrs }
  }

  // Constructs a multiaddr string representing the circuit relay v2 listen address for a relayed connection to the given peer.
  const getRelayListenAddr = (maddr: Multiaddr, peer: PeerId): string =>
    `${maddr.toString()}/p2p/${peer.toString()}/p2p-circuit`


  async function setup() {
    const blockstore = new IDBBlockstore('crdt/bs')
    await blockstore.open()

    const datastore = new IDBDatastore('crdt/ds')
    await datastore.open()

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
      loggerPrefix: 'crdt',
      bloomFilter: null // remove after https://github.com/libp2p/js-libp2p/pull/2687
    }

    try {
      const crdtDS = await newCRDTDatastore(topic, datastore, blockstore, opts)
      setDs(crdtDS)
    } catch (e: any) {
      console.log(e)
      setError(e)
    }
  }

  type PeerProtoTuple = {
    peerId: string
    protocols: string[]
  }

  const getFormattedConnections = (
    connections: Connection[],
  ): PeerProtoTuple[] => {
    const protoNames: Map<string, string[]> = new Map()

    connections.forEach((conn) => {
      if (conn.status === 'open') {
        const exists = protoNames.get(conn.remotePeer.toString())
        const dedupedProtonames = [...new Set(conn.remoteAddr.protoNames())]

        if (exists?.length) {
          const namesToAdd = dedupedProtonames.filter(
            (name) => !exists.includes(name),
          )

          protoNames.set(conn.remotePeer.toString(), [...exists, ...namesToAdd])
        } else {
          protoNames.set(conn.remotePeer.toString(), dedupedProtonames)
        }
      }
    })

    return [...protoNames.entries()].map(([peerId, protocols]) => ({
      peerId,
      protocols,
    }))
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
    setDsKey('')
    setDsValue('')
  }

  const handleGet = async () => {
    const v = await ds?.get(new Key(dsKey))
    if (v !== undefined && v !== null) {
      setDsValue(new TextDecoder().decode(v))
    }
  }

  const handleDelete = async () => {
    await ds?.delete(new Key(dsKey))
    setDsKey('')
    setDsValue('')
  }

  const handleDeleteBin = async (key: Key) => {
    await ds?.delete(key)
  }

  const handleRefresh = async () => {
    await updateDsList()
  }

  const debouncedPut = React.useRef(
    debounce(async (ds: CRDTDatastore | null, key: Key, value: string) => {
      console.log('Debounced Put ', key.toString(), value)
      const v = new TextEncoder().encode(value);
      await ds?.put(key, v);
    }, 500)
  ).current;

  const handleTextAreaChange = async (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setTextAreaValue(event.target.value)
    debouncedPut(ds, new Key(textareaKey), event.target.value)
  }

  const handleContentAddressedTextAreaChange = async (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    try {
      setContentAddressedTextAreaValue(event.target.value)
      const cid = await stringEncoder?.add(event.target.value)
      if (!cid) {
        throw new Error('no cid')
      }

      debouncedPut(ds, new Key(caTextareaKey), cid.toString())
    } catch (e) {
      console.log(e)
    }
  }

  useEffect(() => {
    const init = async () => {
      if (isOnline) {
        if (!isLibp2pInitialized && bootstrapMultiaddrs) {
          await setup();
          isLibp2pInitialized = true;
        } else {
          ds?.dagService.libp2p.start()
          ds?.dagService.start()
        }
      } else {
        await ds?.dagService.libp2p.stop()
        await ds?.dagService.stop()
        // await ds?.close()
        setDialable([])
        setConnections([])
        setPeers([])
        // setDs(null)
        // isLibp2pInitialized = false;
      }
    };

    init();
  }, [isOnline, bootstrapMultiaddrs]);

  // load list, textarea & content addressed textarea
  useEffect(() => {
    const init = async () => {
      if (ds) {
        await updateDsList()

        const v = await ds?.get(new Key(textareaKey))
        if (v !== undefined && v !== null) {
          setTextAreaValue(new TextDecoder().decode(v))

          const history = await ds?.keyHistory(new Key(textareaKey))
          if (history) {
            const historyStrings = history.map(item => item ? new TextDecoder().decode(item) : '');
            setHistory(historyStrings)
          }
        }

        const vca = await ds?.get(new Key(caTextareaKey))
        if (vca !== undefined && vca !== null) {
          const cid = CID.parse(new TextDecoder().decode(vca))
          const string = await stringEncoder?.get(cid)
          if (!string) {
            throw new Error(`could not get content for content addressed text area ${cid.toString()}`)
          }
          setContentAddressedTextAreaValue(string)
        }
      }
    }

    init()
  }, [ds]);

  useEffect(() => {
    const evtProcessor = async (e: any) => {
      console.log('evt', e)

      if (!ds) {
        return
      }

      // Add a delay before running updateDsList to allow for processing
      setTimeout(async () => {
        await updateDsList()

        // update textarea
        if (e.detail === textareaKey) {
          const v = await ds.get(new Key(textareaKey))
          if (v !== undefined && v !== null) {
            setTextAreaValue(new TextDecoder().decode(v))

            const history = await ds?.keyHistory(new Key(textareaKey))
            if (history) {
              const historyStrings = history.map(item => item ? new TextDecoder().decode(item) : '');
              setHistory(historyStrings)
            }
          }
        }

        // update content addressed textarea
        if (e.detail === caTextareaKey) {
          const v = await ds?.get(new Key(caTextareaKey))

          if (v !== undefined && v !== null) {
            const cid = CID.parse(new TextDecoder().decode(v))
            const string = await stringEncoder?.get(cid)
            if (!string) {
              throw new Error(`could not get content for content addressed text area ${cid.toString()}`)
            }
            setContentAddressedTextAreaValue(string)
          }
        }

        let dotString = ''
        await ds.dotDAG((data: string) => {
          dotString += data
        })

        setGraph(graph)

        const renderGraph = async () => {
          const viz = await instance();

          try {
            const svgElement = viz.renderSVGElement(dotString)
            if (graphRef.current) {
              // Clear the previous graph before appending a new one
              graphRef.current.innerHTML = '';
              graphRef.current.appendChild(svgElement);
            }
          } catch (error) {
            console.error('Error rendering the graph:', error);
          }
        };

        renderGraph()
      }, 100)
    }

    document.addEventListener('dsupdate', evtProcessor)

    return () => {
      document.removeEventListener('dsupdate', evtProcessor)
    }
  }, [ds, updateDsList])

  // Connections
  useEffect(() => {
    const interval = setInterval(() => {
      if (!ds?.dagService.libp2p || (ds.dagService.libp2p && ds.dagService.libp2p.status !== 'started')) {
        return
      }

      const connections = ds.dagService.libp2p.getConnections()

      const newPeerStats = {
        connections: connections,
      }

      if (isEqual(newPeerStats, connections)) {
        // console.log('peer stats not changed')
        return
      }

      // eslint-disable-next-line no-console
      //console.debug(`updating peerstats`, newPeerStats)

      setConnections(newPeerStats.connections)
    }, 2000)

    return () => {
      clearInterval(interval)
    }
  }, [ds, connections])

  // Gossip Peers
  useEffect(() => {
    if (!ds?.dagService.libp2p || !topic) {
      return
    }

    const onSubscriptionChange = () => {
      const subscribers = ds.dagService.libp2p.services.pubsub.getSubscribers(
        topic,
      ) as PeerId[]

      console.log('subscribers', subscribers)

      if (subscribers) {
        setPeers(
          subscribers.filter(
            (peer) => !bootstrappers.includes(peer.toString()),
          ),
        )
      }
    }

    onSubscriptionChange()

    ds.dagService.libp2p.services.pubsub.addEventListener(
      'subscription-change',
      onSubscriptionChange,
    )
    return () => {
      ds.dagService.libp2p.services.pubsub.removeEventListener(
        'subscription-change',
        onSubscriptionChange,
      )
    }
  }, [ds, setPeers])


  useEffect(() => {
    const selfPeerUpdateHandler = (evt: any) => {
      if (!ds) {
        return
      }

      const multiaddrs = evt.detail.peer.addresses.map(({ multiaddr }: { multiaddr: Multiaddr }) => multiaddr);
      setBootstrapMultiaddrs(multiaddrs)

      const dialable: string[] = []
      for (const maddr of multiaddrs) {
        const protos = maddr.protoNames()

        if (
          protos.includes('p2p-circuit') && protos.includes('webrtc')
        ) {
          // TODO skip ipv6 loopback
          if (maddr.nodeAddress().address === '127.0.0.1') continue // skip loopback

          dialable.push(`${maddr}/p2p/${ds.dagService.libp2p.peerId.toString()}`)
        }
      }
      setDialable(dialable)
    }

    if (ds) {
      ds.dagService.libp2p.addEventListener('self:peer:update', selfPeerUpdateHandler)
    }

    return () => {
      if (ds) {
        ds.dagService.libp2p.removeEventListener('self:peer:update', selfPeerUpdateHandler)
      }
    }
  }, [ds])

  useEffect(() => {
    const init = async () => {
      if (!ds) {
        return
      }

      setIsDirty(await ds.isDirty())
    }

    init()
  }, [ds])

  useEffect(() => {
    const interval = setInterval(async () => {
      if (!ds?.dagService.libp2p || (ds.dagService.libp2p && ds.dagService.libp2p.status !== 'started')) {
        return
      }

      const stats = await ds.internalStats()
      setHeads(stats?.heads)
      setHeight(stats?.maxHeight)
      setQueuedJobs(stats?.queuedJobs)
      console.log('stats', stats)
    }, 2000)

    return () => {
      clearInterval(interval)
    }
  }, [ds])

  useEffect(() => {
    setIsOnline(navigator.onLine);

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Cleanup event listeners on component unmount
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return (
    <>
      <Head>
        <title>Merkle CRDT Example</title>
        <meta name="description" content="Merkle CRDT Example" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </Head>
      <main>
        {!isOnline && (<Container bg='red.500' color='white' p={4} w='100%'>
          <Center>Your device is offline</Center>
        </Container>
        )}
        {error !== undefined && error !== null && (
          <Container bg='red.500' color='white' p={4} w='100%'>
            {error.code && <Box>Error code: {error.code}</Box>}
            {error.message && <Box>Error message: {error.message}</Box>}
            {error.code === 'ERR_NO_VALID_ADDRESSES' && <Box>The relay servers maybe offline or wait a short while before reloading the page as you may be spamming the relay with reservation requests!</Box>}
          </Container>
        )}
        <Flex
          p={{ base: 2, md: 8 }}
          w="100%"
          direction={{ base: 'column', md: 'row' }}
        >
          <Container pt="2">
            <Heading as='h3'>Merkle CRDT key-value store demo</Heading>
            <Text>More info:<Link href="https://github.com/dozyio/js-ds-crdt" isExternal>js-ds-crdt <ExternalLinkIcon mx='2px' /></Link></Text>
            <Text>Based on the paper: <Link href="https://arxiv.org/abs/2004.00107" isExternal>Merkle-CRDTs: Merkle-DAGs meet CRDTs <ExternalLinkIcon mx='2px' /></Link></Text>
            <Text>Open the site in two browsers (e.g., Chrome and Firefox) to observe data syncing between them. Since data is stored in each browser&apos;s IndexedDB, you&apos;ll need to use two different browser instances.</Text>
            <Heading as='h3'>Key Value Operations</Heading>
            <Box>
              Key: <Input value={dsKey}
                onChange={handleKeyChange} />
              Value: <Input value={dsValue}
                onChange={handleValueChange} />
              <Button onClick={handlePut}>Put</Button>
              <Button onClick={handleGet}>Get</Button>
              <Button onClick={handleDelete}>Delete</Button>
            </Box>
            <Box>
              <Heading as='h3'>Textarea Example</Heading>
              <Textarea value={textAreaValue} onChange={handleTextAreaChange} />
              <Heading as='h6' size='sm'>Textarea History</Heading>
              <Box maxH='100px' overflowY='scroll'>
                <UnorderedList>
                  {history.map((item, index) => (
                    <ListItem key={index}>
                      {item}
                    </ListItem>
                  ))}
                </UnorderedList>
              </Box>
            </Box>
            <Box>
              <Heading as='h3'>Content Addressed Textarea Example</Heading>
              <Textarea value={contentAddressedTextAreaValue} onChange={handleContentAddressedTextAreaChange} />
            </Box>
            <Box mb={2}>
              <Heading as='h3'>KV Store</Heading>
              <Box>
                {dsList.map((pair, index) => (
                  <Box key={index}>
                    <IconButton onClick={() => handleDeleteBin(pair.key)} aria-label='Delete' icon={<DeleteIcon />} mr={2} />
                    {pair.key.toString()} : {new TextDecoder().decode(pair.value)}
                  </Box>
                ))}
                <Button onClick={handleRefresh} mt={2}>Reload store</Button>
              </Box>
            </Box>
          </Container>
          <Container pt="2">
            <Box>
              <Heading as='h3'>Config</Heading>
              <UnorderedList>
                <ListItem>Topic: {topic}</ListItem>
                <ListItem>DHT Prefix: {dhtPrefix}</ListItem>
                <ListItem>Bootstrappers {bootstrappers.join(', ')}</ListItem>
                <ListItem>Delegated Router: {delegatedRouterUrl}</ListItem>
              </UnorderedList>
            </Box>
            <Box>
              <Heading as='h3'>DAG</Heading>
              <Box>Height: {height ? height.toString() : 0}</Box>
              <Box>Heads:</Box>
              <UnorderedList>
                {heads && heads.map((head, index) => (
                  <ListItem key={index}>
                    {head.toString()}
                  </ListItem>
                ))}
              </UnorderedList>
              <Box>Dirty: {isDirty ? "Yes" : "No"}</Box>
              <Box>Queued Jobs: {queuedJobs}</Box>
            </Box>
            <Box>
              <Heading as='h3'>Dial a peer</Heading>
              <Input
                value={remoteMultiaddr}
                onChange={handleMAChange}
                placeholder="Multiaddr"
              />
              <Button onClick={handleConnect}>Connect</Button>
            </Box>
            <Box>
              <Heading as='h3'>Gossip Peers</Heading>
              <UnorderedList>
                {peers && peers.map((peer) => (
                  <ListItem key={peer.toString()}>
                    {peer.toString()}
                  </ListItem>
                ))}
              </UnorderedList>
            </Box>
            <Box>
              <Heading as='h3'>Browser Dialable Multiaddrs</Heading>
              <UnorderedList>
                {dialable.map((ma, index) => (
                  <ListItem key={index}>
                    {ma.toString()}
                  </ListItem>
                ))}
              </UnorderedList>
            </Box>
            <Box>
              <Heading as='h3'>All Multiaddrs</Heading>
              <UnorderedList>
                {bootstrapMultiaddrs.map((ma, index) => (
                  <ListItem key={index}>
                    {ma.toString() + '/p2p/' + ds?.dagService.libp2p.peerId.toString()}
                  </ListItem>
                ))}
              </UnorderedList>
            </Box>
            <Box>
              <Heading as='h3'>Connections</Heading>
              <UnorderedList>
                {getFormattedConnections(connections).map((pair) => (
                  <ListItem
                    key={pair.peerId}
                  >
                    {pair.peerId} ({pair.protocols.join(', ')})
                  </ListItem>
                ))}
              </UnorderedList>
            </Box>
          </Container>
        </Flex>
        <Box>
          <Heading as='h3'>Graph</Heading>
          <Center>
            <Box maxW='100%' overflow='scroll' ref={graphRef}></Box>
          </Center>
        </Box>
      </main>
    </>
  );
}
