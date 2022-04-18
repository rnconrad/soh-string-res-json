import { BinaryStruct, BinaryType, sizeOf, binaryStruct, binaryField } from "binary-struct-ts";
import fs from "fs";
import YAML from 'yaml';

@binaryStruct()
class ResourceFileHeader extends BinaryStruct
{
  @binaryField(BinaryType.BigUint64)
  id: BigInt;
  @binaryField(BinaryType.Uint32)
  resourceMinorVersion: number;
  @binaryField(BinaryType.BigUint64)
  romCrc: BigInt;
  @binaryField(BinaryType.Uint32)
  romEnum: number;
};

@binaryStruct()
class TextResourceHeader extends BinaryStruct
{
  @binaryField(BinaryType.Int32)
  msgCount: number;
};

@binaryStruct()
class MessageEntry extends BinaryStruct
{
  @binaryField(BinaryType.Uint16)
  id: number;
  @binaryField(BinaryType.Uint8)
  textboxType: number;
  @binaryField(BinaryType.Uint8)
  textboxYPos: number;
  @binaryField(BinaryType.Int32)
  numChars: number;
};

function binaryToText(inputFilename: string, outputFilename: string) {
  const fileBuffer = fs.readFileSync(inputFilename).buffer;

  const RESOURCE_HEADER_SIZE = 64;
  const resourceHeader = new ResourceFileHeader(fileBuffer);

  const header = new TextResourceHeader(fileBuffer, RESOURCE_HEADER_SIZE);
  if (header.msgCount <= 0 || header.msgCount > 0xFFFF) {
    throw new Error(`Bad message count (${header.msgCount}), possibly invalid input.`);
  }

  let fileOffset = RESOURCE_HEADER_SIZE + sizeOf(TextResourceHeader);
  const messages = [];

  for (let i = 0; i < header.msgCount; i++) {
    const messageEntry = new MessageEntry(fileBuffer, fileOffset);
    const messageJson = Object.assign({}, messageEntry.toJSON());
    delete messageJson.numChars;
    messageJson.id = `0x${Number(messageJson.id).toString(16)}`;
    messageJson.text = Buffer.from(fileBuffer, fileOffset + sizeOf(MessageEntry),
      messageEntry.numChars).toString("utf8");
    messages.push(messageJson);

    fileOffset += sizeOf(MessageEntry) + messageEntry.numChars;
  }

  if (outputFilename.endsWith(".yaml") || outputFilename.endsWith(".yml")) {
    fs.writeFileSync(outputFilename, YAML.stringify(messages));
  } else {
    fs.writeFileSync(outputFilename, JSON.stringify(messages));
  }
}

async function textToBinary(inputFilename: string, outputFilename: string) {
  let messages: any;
  if (inputFilename.endsWith(".yaml") || inputFilename.endsWith(".yml")) {
    messages = YAML.parse(fs.readFileSync(inputFilename, "utf8"));
  } else {
    messages = JSON.parse(fs.readFileSync(inputFilename, "utf8"));
  }

  const RESOURCE_HEADER_SIZE = 64;
  const resourceHeader = new ResourceFileHeader(new Uint8Array(RESOURCE_HEADER_SIZE).buffer);

  if (false && fs.existsSync(outputFilename) && fs.statSync(outputFilename).size > RESOURCE_HEADER_SIZE) {
    //patch existing file
    const existingBuffer = fs.readFileSync(outputFilename).buffer;
    const prevHeader = new ResourceFileHeader(existingBuffer);
    resourceHeader.copyFrom(prevHeader);
  } else {
    resourceHeader.id = 5716290944840499200n;
  }

  const outStream = fs.createWriteStream(outputFilename);
  const writeToStream = async (data: DataView | Uint8Array) => new Promise<void>((resolve, reject) =>
  {
    if (data instanceof DataView) {
      data = new Uint8Array(data.buffer);
    }
    outStream.write(data, (err) => (err) ? reject(err) : resolve());
  });

  await writeToStream(resourceHeader.asDataView());

  const header = new TextResourceHeader(new Uint8Array(sizeOf(TextResourceHeader)).buffer);
  header.msgCount = messages.length;
  await writeToStream(header.asDataView());

  let prevId = 0;
  const messageIds = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const messageEntry = new MessageEntry(new Uint8Array(sizeOf(MessageEntry)).buffer);
    let messageId;
    if (typeof message.id === "number") {
      messageId = message.id;
    } else if (typeof message.id === "string") {
      let radix = 10;
      if (message.id.startsWith("0x")) radix = 16;
      messageId = parseInt(message.id, radix);
    } else {
      messageId = prevId + 1;
    }
    if (messageId > 0xFFFF) {
      //pack into textbox fields
      if (((messageId >> 16) & 0xFFFF) === 0xFFFF) {
        messageEntry.id = messageId & 0xFFFF;
      } else {
        messageEntry.id = (messageId >> 16) & 0xFFFF;
        messageEntry.textboxType = (messageId >> 8) & 0xFF;
        messageEntry.textboxYPos = (messageId >> 0) & 0xFF;
      }
    } else {
      messageEntry.id = messageId;
      messageEntry.textboxType = messages[i].textboxType || 0;
      messageEntry.textboxYPos = messages[i].textboxYPos || 0;
    }
    const messageText = (typeof message === "string") ? message : message.text;
    const messageBuffer = Buffer.from(messageText, "utf8");
    messageEntry.numChars = messageBuffer.length;
    await writeToStream(messageEntry.asDataView());
    await writeToStream(messageBuffer);

    if (messageIds.has(messageEntry.id)) {
      console.warn(`Warning: duplicate message id found: ${messageEntry.id}`);
    }
    messageIds.add(messageEntry.id);
    prevId = messageEntry.id;
  }

  await new Promise((resolve, reject) =>
  {
    outStream.close(resolve);
  });
}

if (process.argv.length <= 2) {
  console.log("Usage: [input filename] [output filename]");
  process.exit(1);
}

const inputFilename = process.argv[2];
if (!inputFilename || !fs.existsSync(inputFilename)) {
  console.log("Usage: [input filename] [output filename]");
  throw new Error("No input file specified.");
}

const outputFilename = process.argv[3];
if (!outputFilename) {
  console.log("Usage: [input filename] [output filename]");
  throw new Error("No output file specified.");
}

console.log(`Converting "${inputFilename}" to "${outputFilename}"`);

const dataExtensions = ['.yaml', '.yml', '.json'];
if (dataExtensions.some((ext) => inputFilename.endsWith(ext))) {
  textToBinary(inputFilename, outputFilename);
} else if (dataExtensions.some((ext) => outputFilename.endsWith(ext))) {
  binaryToText(inputFilename, outputFilename);
} else {
  throw new Error("Could not infer conversion from the provided file extensions (use '.json' or '.yaml' extension).");
}