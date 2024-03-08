import { useEffect, useState } from "react";
import axios from "axios";
import { networks, payments, Psbt } from "bitcoinjs-lib";
import {
  Network,
  OrdConnectKit,
  OrdConnectProvider,
  useBalance,
  useOrdConnect,
  useSign,
} from "@ordzaar/ord-connect";
import {
  ADDRESS_FORMAT_TO_TYPE,
  AddressFormat,
  AddressType,
  getAddressesFromPublicKey,
  JsonRpcDatasource,
} from "@ordzaar/ordit-sdk";

import "./style.css";

// DO NOT USE THIS CODE ON PRODUCTION, EXPERIMENTAL ONLY

// https://github.com/ordinals/ord/blob/master/src/runes/rune_id.rs#L20
function fromRuneIdToEdictId(id: string): number {
  const [height, index] = id.split(":");
  // eslint-disable-next-line
  const CLAIM_BIT: bigint = BigInt(1) << BigInt(48);
  return Number(
    // eslint-disable-next-line
    (BigInt(height) << BigInt(16)) | BigInt(index) | CLAIM_BIT,
  );
}

// https://github.com/ordinals/ord/blob/master/src/runes/spaced_rune.rs#L12
function fromRuneStrToSpacer(runeStr: string) {
  let rune = "";
  let spacers = 0;

  // eslint-disable-next-line
  for (const c of runeStr) {
    if (/[A-Z]/.test(c)) {
      rune += c;
    } else if (c === "." || c === "•") {
      // eslint-disable-next-line
      const flag = 1 << (rune.length - 1);
      // eslint-disable-next-line
      if ((spacers & flag) !== 0) {
        throw new Error("double spacer");
      }
      // eslint-disable-next-line
      spacers |= flag;
    } else {
      throw new Error("invalid character");
    }
  }

  if (32 - Math.clz32(spacers) >= rune.length) {
    throw new Error("trailing spacer");
  }

  return { rune, spacers };
}

// async function getRunes() {
//   const response = await axios.get("http://18.140.248.16:3033/runes", {
//     headers: {
//       Accept: "application/json",
//     },
//   });
//   return response.data as {
//     entries: [
//       string,
//       {
//         burned: number;
//         divisibility: number;
//         etching: string;
//         mint: object;
//         mints: number;
//         number: number;
//         rune: string;
//         spacers: number;
//         supply: number;
//         symbol: string;
//         timestamp: number;
//       },
//     ][];
//   };
// }

async function getRuneByName(name: string) {
  const response = await axios.get(`http://18.140.248.16:3033/rune/${name}`, {
    headers: {
      Accept: "application/json",
    },
  });
  return response.data as {
    entry: {
      burned: number;
      divisibility: number;
      etching: string;
      mint: {
        deadline?: number;
        end?: number;
        limit?: number;
      };
      mints: number;
      number: number;
      rune: string;
      spacers: number;
      supply: number;
      symbol: string;
      timestamp: number;
    };
    id: string;
  };
}

async function generateRuneScript(data: {
  runestone: {
    edicts: {
      id: number;
      amount: number;
      output: number;
    }[];
    etching: {
      divisibility: number;
      mint?: {
        deadline?: number | null;
        limit?: number | null;
        term?: number | null;
      };
      rune: string;
      spacers: number;
      symbol?: string;
    } | null;
    default_output?: boolean;
    burn: boolean;
  };
  validate: boolean;
  bitcoin_height?: number;
}) {
  const response = await axios.post(
    "http://18.140.248.16:3033/runes/encipher",
    data,
    {
      headers: {
        Accept: "application/json",
      },
    },
  );
  return response.data as {
    script_hex: string;
  };
}

function generateEtchingData(
  data: {
    divisibility: number;
    mint: {
      deadline?: number;
      limit?: number;
      term?: number;
    };
    rune: string;
    symbol?: string;
  },
  bitcoinHeight: number,
) {
  let rune = "";
  let spacers = 0;

  if (data.rune !== "") {
    const s = fromRuneStrToSpacer(data.rune);
    rune = s.rune;
    spacers = s.spacers;
  }

  return {
    runestone: {
      edicts: [],
      etching: {
        divisibility: data.divisibility,
        mint: {
          deadline: data.mint.deadline === 0 ? null : data.mint.deadline,
          limit: data.mint.limit === 0 ? null : data.mint.limit,
          term: data.mint.term === 0 ? null : data.mint.term,
        },
        rune,
        spacers,
        symbol: data.symbol,
      },
      burn: false,
    },
    validate: true,
    bitcoin_height: bitcoinHeight,
  };
}

function generateEdictsData(
  data: {
    id: number;
    amount: number;
    output: number;
  }[],
  burn: boolean,
) {
  return {
    runestone: {
      edicts: data,
      etching: null,
      burn,
    },
    validate: false,
  };
}

async function getOrdOutput(outpoint: string) {
  const response = await axios.get(
    `http://18.140.248.16:3033/output/${outpoint}`,
    {
      headers: {
        Accept: "application/json",
      },
    },
  );
  return response.data as {
    address: string;
    indexed: boolean;
    inscriptions: object[];
    runes: [string, { amount: number; divisibility: number; symbol: string }][];
    sat_ranges: number[][];
    script_pubkey: string;
    spent: boolean;
    transaction: string;
    value: number;
  };
}

async function getUTXOs(
  addressPublicKey: string,
  addressFormat: AddressFormat,
  network: Network,
) {
  const { address } = getAddressesFromPublicKey(
    addressPublicKey,
    network,
    ADDRESS_FORMAT_TO_TYPE[addressFormat] as Exclude<AddressType, "p2wsh">,
  )[0];

  const rpc = new JsonRpcDatasource({ network });
  const unspents = await rpc.getUnspents({
    address,
    type: "all",
    rarity: [],
  });
  return unspents;
}

async function getRuneBalance(
  addressPublicKey: string,
  addressFormat: AddressFormat,
  network: Network,
) {
  const utxos = await getUTXOs(addressPublicKey, addressFormat, network);

  const runeMap = new Map();

  for (let i = 0; i < utxos.unspendableUTXOs.length; i += 1) {
    const utxo = utxos.unspendableUTXOs[i];
    // eslint-disable-next-line
    const output = await getOrdOutput(`${utxo.txid}:${utxo.n}`);

    for (let j = 0; j < output.runes.length; j += 1) {
      const rune = output.runes[j];
      const runeValue = runeMap.get(rune[0]) || 0;
      runeMap.set(rune[0], runeValue + rune[1].amount);
    }
  }

  return runeMap;
}

// type Rune = {
//   id: number;
//   rune: string;
// };

// function RuneList() {
//   const [runes, setRunes] = useState<Rune[]>([]);
//
//   useEffect(() => {
//     getRunes().then((data) => {
//       const r: Rune[] = [];
//       data.entries.forEach((v) => {
//         r.push({
//           id: fromRuneIdToEdictId(parseRuneIdFromStr(v[0])),
//           rune: v[1].rune,
//         });
//       });
//       setRunes(r);
//     });
//   }, []);
//
//   return (
//     <>
//       <p>All Runes</p>
//       <p>{JSON.stringify(runes)}</p>
//     </>
//   );
// }

function UserBalance() {
  const { network, publicKey, format } = useOrdConnect();
  const { getBalance } = useBalance();

  const [balance, setBalance] = useState<number | undefined>(undefined);
  const [runeBalance, setRuneBalance] = useState<
    Map<string, number> | undefined
  >(undefined);

  useEffect(() => {
    getBalance().then((_balance) => {
      setBalance(_balance);
    });
  }, [getBalance]);

  useEffect(() => {
    getRuneBalance(publicKey.ordinals!, format.ordinals!, network).then(
      (runeMap) => {
        setRuneBalance(runeMap);
      },
    );
  }, [network, publicKey, format]);

  return (
    <>
      <p>Payment Address Balances</p>
      <p>{JSON.stringify(balance)} sats</p>
      <p>Ord Address Rune Balances</p>
      <p>
        {JSON.stringify(runeBalance ? Array.from(runeBalance.entries()) : [])}
      </p>
    </>
  );
}

function CreateRune() {
  const [formData, setFormData] = useState({
    divisibility: 0,
    mint: {
      deadline: 0,
      limit: 0,
      term: 0,
    },
    rune: "RUNE",
    symbol: "Z",
    bitcoin_height: 0,
  });

  const [etching, setEtching] = useState<object | null>(null);

  const [runeScript, setRuneScript] = useState("");

  const handleChange = (event: any) => {
    const { name, value } = event.target;
    setFormData((prevFormData) => {
      const updated = { ...prevFormData };

      if (name === "divisibility") {
        updated.divisibility = parseInt(value, 10);
      }

      if (name === "mint.deadline") {
        updated.mint.deadline = parseInt(value, 10);
      }

      if (name === "mint.limit") {
        updated.mint.limit = parseInt(value, 10);
      }

      if (name === "mint.term") {
        updated.mint.term = parseInt(value, 10);
      }

      if (name === "rune") {
        updated.rune = value.toUpperCase();
      }

      if (name === "symbol") {
        updated.symbol = value.toUpperCase();
      }

      if (name === "bitcoin_height") {
        updated.bitcoin_height = parseInt(value, 10);
      }

      return updated;
    });
  };

  const handleCreate = () => {
    const etchingData = generateEtchingData(formData, formData.bitcoin_height);
    setEtching(etchingData);

    generateRuneScript(etchingData)
      .then((v) => {
        setRuneScript(v.script_hex);
      })
      .catch((e) => {
        if (e.response?.data) {
          alert(e.response?.data);
        } else {
          alert(JSON.stringify(e));
        }
      });
  };

  const { network, publicKey, format } = useOrdConnect();
  const { sign } = useSign();

  const doCreateRuneTx = async () => {
    const { address } = getAddressesFromPublicKey(
      publicKey.payments!,
      network,
      ADDRESS_FORMAT_TO_TYPE[format.payments!] as Exclude<AddressType, "p2wsh">,
    )[0];

    const payment = payments.p2sh({
      redeem: payments.p2wpkh({
        pubkey: Buffer.from(publicKey.payments!, "hex"),
        network: networks.testnet,
      }),
      network: networks.testnet,
    });

    const rpc = new JsonRpcDatasource({ network });

    const runeSat = 0; // for rune sat
    const fee = 2000; // harcoded fee
    const valueSat = runeSat + fee;
    const valueBTC = valueSat / 10 ** 8;

    const spendables = await rpc.getSpendables({
      address,
      value: valueBTC,
    });

    const psbt = new Psbt({ network: networks.testnet });

    const totalSats = spendables.reduce((a, b) => a + b.sats, 0);
    psbt.addInputs(
      spendables.map((v) => ({
        type: "nested-segwit",
        hash: v.txid,
        index: v.n,
        redeemScript: payment.redeem!.output!,
        witnessUtxo: {
          script: Buffer.from(v.scriptPubKey.hex, "hex"),
          value: v.sats,
        },
      })),
    );

    psbt.addOutput({
      script: Buffer.from(runeScript, "hex"),
      value: 0,
    });

    psbt.addOutput({
      address,
      value: totalSats - valueSat,
    });

    const psbtBase64 = psbt.toBase64();

    const signed = await sign(address, psbtBase64, {
      finalize: true,
      extractTx: true,
      signingIndexes: [0],
    });

    const result = await rpc.relay({ hex: signed.hex });
    return result;
  };

  const handleDoCreateRuneTx = async () => {
    if (format.payments !== "p2sh-p2wpkh") {
      alert(
        "rn only support for nested-segwit/p2sh-p2wpkh payment, use xverse wallet, TODO: handle using ordit-sdk lib",
      );
    }

    doCreateRuneTx()
      .then((v) => {
        alert(`https://mempool.space/testnet/tx/${v}`);
      })
      .catch((e) => {
        alert(JSON.stringify(e));
      });
  };

  return (
    <>
      <p>Create Rune</p>

      <form>
        <p>divisibility</p>
        <input
          type="number"
          name="divisibility"
          value={formData.divisibility}
          onChange={handleChange}
        />
        <p>mint.deadline</p>
        <input
          type="number"
          name="mint.deadline"
          value={formData.mint.deadline}
          onChange={handleChange}
        />
        <p>mint.limit</p>
        <input
          type="number"
          name="mint.limit"
          value={formData.mint.limit}
          onChange={handleChange}
        />
        <p>mint.term</p>
        <input
          type="number"
          name="mint.term"
          value={formData.mint.term}
          onChange={handleChange}
        />
        <p>rune</p>
        <input
          type="text"
          name="rune"
          value={formData.rune}
          onChange={handleChange}
        />
        <p>symbol</p>
        <input
          type="text"
          name="symbol"
          value={formData.symbol}
          onChange={handleChange}
        />
        <p>
          current bitcoin height (paste it manually from mempool, this will be
          used for validation)
        </p>
        <input
          type="number"
          name="bitcoin_height"
          value={formData.bitcoin_height}
          onChange={handleChange}
        />
        <p />
        <button type="button" onClick={handleCreate}>
          Generate
        </button>
        {runeScript ? (
          <button type="button" onClick={handleDoCreateRuneTx}>
            Do Transaction
          </button>
        ) : null}
      </form>

      <p>etching data: {JSON.stringify(etching)}</p>
      <p>rune script: {JSON.stringify(runeScript)}</p>
      <p />
    </>
  );
}

function RuneDetail() {
  const [formData, setFormData] = useState({
    name: "",
  });

  const [detail, setDetail] = useState<any>(null);

  const handleChange = (event: any) => {
    const { name, value } = event.target;
    setFormData((prevFormData) => {
      const updated = { ...prevFormData };

      if (name === "name") {
        updated.name = value.toUpperCase();
      }

      return updated;
    });
  };

  const handleDetail = () => {
    getRuneByName(formData.name)
      .then((v) => {
        setDetail(v);
      })
      .catch((e) => {
        if (e.response?.data) {
          alert(e.response?.data);
        } else {
          alert(JSON.stringify(e));
        }
      });
  };

  return (
    <>
      <p>Rune Detail</p>

      <form>
        <p>Rune</p>
        <input
          type="text"
          name="name"
          value={formData.name}
          onChange={handleChange}
        />
        <p />
        <button type="button" onClick={handleDetail}>
          Detail
        </button>
      </form>

      {detail ? (
        <>
          <p>rune script: {JSON.stringify(detail)}</p>
          <p>rune id: {detail.id}</p>
          <p>edict id: {fromRuneIdToEdictId(detail.id)}</p>
        </>
      ) : null}
      <p />
    </>
  );
}

function MintRune() {
  const [formData, setFormData] = useState({
    id: 0,
    amount: 0,
    output: 1, // default output rune
  });

  const [edict, setEdict] = useState<object | null>(null);

  const [runeScript, setRuneScript] = useState("");

  const handleChange = (event: any) => {
    const { name, value } = event.target;
    setFormData((prevFormData) => {
      const updated = { ...prevFormData };

      if (name === "id") {
        updated.id = parseInt(value, 10);
      }

      if (name === "amount") {
        updated.amount = parseInt(value, 10);
      }

      return updated;
    });
  };

  const handleCreate = () => {
    const edictData = generateEdictsData([formData], false);
    setEdict(edictData);

    generateRuneScript(edictData)
      .then((v) => {
        setRuneScript(v.script_hex);
      })
      .catch((e) => {
        if (e.response?.data) {
          alert(e.response?.data);
        } else {
          alert(JSON.stringify(e));
        }
      });
  };

  const { network, publicKey, format } = useOrdConnect();
  const { sign } = useSign();

  const doMintTx = async () => {
    const { address: paymentAddress } = getAddressesFromPublicKey(
      publicKey.payments!,
      network,
      ADDRESS_FORMAT_TO_TYPE[format.payments!] as Exclude<AddressType, "p2wsh">,
    )[0];

    const { address: ordinalAddress } = getAddressesFromPublicKey(
      publicKey.ordinals!,
      network,
      ADDRESS_FORMAT_TO_TYPE[format.ordinals!] as Exclude<AddressType, "p2wsh">,
    )[0];

    const payment = payments.p2sh({
      redeem: payments.p2wpkh({
        pubkey: Buffer.from(publicKey.payments!, "hex"),
        network: networks.testnet,
      }),
      network: networks.testnet,
    });

    const rpc = new JsonRpcDatasource({ network });

    const runeSat = 600; // for rune sat
    const fee = 1000; // harcoded fee
    const valueSat = runeSat + fee;
    const valueBTC = valueSat / 10 ** 8;

    const spendables = await rpc.getSpendables({
      address: paymentAddress,
      value: valueBTC,
    });

    const psbt = new Psbt({ network: networks.testnet });

    const totalSats = spendables.reduce((a, b) => a + b.sats, 0);
    psbt.addInputs(
      spendables.map((v) => ({
        type: "nested-segwit",
        hash: v.txid,
        index: v.n,
        redeemScript: payment.redeem!.output!,
        witnessUtxo: {
          script: Buffer.from(v.scriptPubKey.hex, "hex"),
          value: v.sats,
        },
      })),
    );

    psbt.addOutput({
      script: Buffer.from(runeScript, "hex"),
      value: 0,
    });

    psbt.addOutput({
      address: ordinalAddress,
      value: runeSat,
    });

    psbt.addOutput({
      address: paymentAddress,
      value: totalSats - valueSat,
    });

    const psbtBase64 = psbt.toBase64();

    console.log({ psbtBase64 });

    const signed = await sign(paymentAddress, psbtBase64, {
      finalize: true,
      extractTx: true,
      signingIndexes: [0],
    });

    const result = await rpc.relay({ hex: signed.hex });
    return result;
  };

  const handleDoMintTx = async () => {
    if (format.payments !== "p2sh-p2wpkh") {
      alert(
        "rn only support for nested-segwit/p2sh-p2wpkh payment, use xverse wallet, TODO: handle using ordit-sdk lib",
      );
    }

    doMintTx()
      .then((v) => {
        alert(`https://mempool.space/testnet/tx/${v}`);
      })
      .catch((e) => {
        alert(JSON.stringify(e));
      });
  };

  return (
    <>
      <p>Mint Rune</p>

      <form>
        <p>id</p>
        <input
          type="number"
          name="id"
          value={formData.id}
          onChange={handleChange}
        />
        <p>amount</p>
        <input
          type="number"
          name="amount"
          value={formData.amount}
          onChange={handleChange}
        />
        <p />
        <button type="button" onClick={handleCreate}>
          Generate
        </button>
        {runeScript ? (
          <button type="button" onClick={handleDoMintTx}>
            Do Transaction
          </button>
        ) : null}
      </form>

      <p>edict data: {JSON.stringify(edict)}</p>
      <p>rune script: {JSON.stringify(runeScript)}</p>
      <p />
    </>
  );
}

function RuneTest() {
  return (
    <div>
      <UserBalance />
      <div className="line" />
      <CreateRune />
      <div className="line" />
      <RuneDetail />
      <div className="line" />
      <MintRune />
      <div className="line" />
      {/* <RuneList /> */}
      {/* <div className="0" /> */}
    </div>
  );
}

export function SampleApp() {
  return (
    <div className="app">
      <OrdConnectProvider initialNetwork={Network.TESTNET}>
        <OrdConnectKit disableMobile={false} />
        <div className="content">
          <RuneTest />
        </div>
      </OrdConnectProvider>
    </div>
  );
}
