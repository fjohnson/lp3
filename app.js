const crypto = require('crypto');
const prettyFormat = require('pretty-format');
const bencode = require('bencode');
const fs = require('fs');
const http = require('http');
const url = require('url');
const net = require('net');
const path = require('path');
const bitwise = require('bitwise');
const defaultEncoding = 'utf8'; //presumed default encoding of torrent file
const peerId = '3F6601FEE1E850AEBDCE';
const PEER_TIME_OUT = 60*2000;

const CHOKE = 0;
const UNCHOKE = 1;
const INTERESTED = 2;
const UNINTERESTED = 3;
const HAVE = 4;
const BIT_FIELD = 5;
const REQUEST = 6;
const PIECE = 7;
const CANCEL = 8;
const PORT = 9;
const HANDSHAKE = 10;
const WAITING_ON_DATA = 11;
const READ_CMD_LEN = 12;
const READ_CMD_ID = 13;

const torrentBitFields = new Map();
const dlBitFields = new Map();

function getInfoSha1(buf){
    let hash = crypto.createHash('sha1');
    hash.update(buf);
    return hash.digest();
}

function getPiecesHash(piecesStr, encoding){
    let buf1 = Buffer.from(piecesStr, encoding ? encoding : defaultEncoding)
    let hashArray = []

    for(let s=0; s<buf1.length; s+=20){
        hashArray.push(buf1.toString('hex',s,s+20));
    }
    return hashArray; 
}

function parseLong(trackerRes){
    for(let p of trackerRes.peers){
        p.ip = p.ip.toString(defaultEncoding);
        p['peer id'] = p['peer id'].toString('hex');
    }
    return trackerRes;
}

function httpRequest(url, callback){
    http.get(url, (res) => {
        const contentType = res.headers['content-type'];
        const { statusCode } = res;
        
        let error;
        if(statusCode === 301){
            let location = res.headers['location'];
            return httpRequest(location, callback);
        }else if (statusCode !== 200) {
            error = new Error('Request Failed.\n' +
                            `Status Code: ${statusCode}`);
        } else if (!/^text\/plain|html/.test(contentType)) {
            error = new Error('Invalid content-type.\n' +
                            `Expected text/plain or text/html but received ${contentType}`);
        }

        if (error) {
            console.error(error.message);
            // Consume response data to free up memory
            res.resume();
            return;
        }
        
        let rawData = [];
        res.on('data', (chunk) => { 
            rawData.push(chunk); 
        });
        res.on('end', () => {
            let charset = contentType.match(/charset=(?<charset>.+)/);
            if(charset){
                charset = charset.groups.charset;
            }
            callback(rawData, charset);
        });
            
    }).on('error', (e) => {
        console.error(`Got error: ${e.message}`);
    });  
}

function parseCompact(bdict){
    let peers = [];
    let i = 0;
    while(i < bdict.peers.length){
        let pid = bdict.peers.slice(i,i+4).join('.');
        let port = parseInt(bdict.peers.slice(i+4,i+6).toString('hex'),16);
        peers.push({'peer id': pid, 'port': port})
        i+=6;
    }
    return peers;
}

function checkReturnType(bdict){
    if(bdict.peers && bdict.peers[0]['peer id'] !== undefined){
        return true; //True if response is not compact
    }
    return false;   //False otherwise
}
function generatePeerId(){
    return escapePeerId(crypto.randomBytes(20).toString('base64'));
}

function escapePeerId(id){
    let idchars = [];
    for(let i=0; i<id.length; i++){
        let c = id.charAt(i).charCodeAt(0);
        if( !((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 127)) ) {
            idchars.push('%');
            idchars.push(Buffer.from(id.charAt(i)).toString('hex'));
        }
        else{
            idchars.push(id.charAt(i));
        }
    }
    return idchars.join('');
}

function escapeBinary(buffer){
    let escBinary = [];
    for(let i=0; i<buffer.byteLength; i++){
        escBinary.push('%');
        let hex = buffer[i].toString(16);
        if(hex.length === 1){
            hex = '0' + hex;
        }
        escBinary.push(hex);
    }
    return escBinary.join('');
}

class Torrent{
    constructor(filename){
        this.filename = filename;
        this.blockOffset = 0; 
        this.blockReqLen = Math.pow(2,14);
    }

    readFile(){
        //archlinux-2019.08.01-x86_64.iso.torrent')//'tab2019-08-10-m21 (flac24).torrent')
        //'Richie Hayward - 1991-11-11 Club Loonies, Nijmegen, Holland [TTD].torrent'
        fs.promises.readFile(this.filename)
        .then((data)=>{

            this.bdict = bencode.decode(data);
            if(this.bdict.encoding){
                this.encoding = this.bdict.encoding.toString();
            }else{
                this.encoding = defaultEncoding;
            }
            let infoVal = getInfoSha1(bencode.encode(this.bdict.info));
            this.bdict = this.makeReadable(this.bdict);
            this.bdict.infoChkSum = escapeBinary(infoVal);
            this.bdict.info.piecesChkSum = (getPiecesHash(this.bdict.info.pieces, this.bdict.encoding));
            this.createBitField();
            let trackerUrl = new url.URL(this.bdict.announce);
            
            //this.scrapeTracker(trackerUrl, this.bdict, this.bdict.infoChkSum);
            //this.talkTracker(trackerUrl, this.bdict);
            this.handShake(infoVal);
        })
        .catch((error)=>{
            console.log(error);
        });
    }
    
    createBitField(){
        //bitfield already created for this torrent. state kept globally.
        if(torrentBitFields[this.filename]) return;

        let totalSize = 0;
        if(this.bdict.info.files){
            for(let f of this.bdict.info.files){
                totalSize += f.length;
            }
        }else{
            totalSize = this.bdict.info.length;
        }

        let numPieces = Math.ceil(totalSize / this.bdict.info['piece length']);
        this.lastPieceSize = totalSize % this.bdict.info['piece length'];
        this.totalSize = totalSize;
        this.numPieces = numPieces;
        torrentBitFields[this.filename] = Buffer.alloc(Math.ceil(numPieces / 8)).fill(0);
        dlBitFields[this.filename] = Buffer.from(torrentBitFields[this.filename]);
    }

    generateFileNamePieceMap(){
        let pm = new Map(this.numPieces);
        let files;
        let plen = this.bdict.info['pieces length'];
        if(this.bdict.info.files){
            files = this.bdict.info.files;
        }else{
            files = [{path:this.bdict.info.name, length:this.bdict.info.length}];
        }

        let i = 0;
        let k = 0;
        let file;
        let bytesRemaining = 0;
        let pieceBytesRemaining = 0;
        let offset = 0;
        let len = 0;
        let record;
        while(i<this.numPieces){
            if(!pieceBytesRemaining){
                pieceBytesRemaining = plen;
                if(i===this.numPieces-1){
                    pieceBytesRemaining = this.lastPieceSize;
                }
                i++;
            }
            if(!bytesRemaining){
                file = files[k++];
                bytesRemaining = file.length;
                offset = 0;
            }
            if(bytesRemaining >= pieceBytesRemaining){
                bytesRemaining -= pieceBytesRemaining;
                len += pieceBytesRemaining;
                record = {name: file.path, offset: offset, len: len};
                len = 0;
                offset += pieceBytesRemaining;
                pieceBytesRemaining = 0;
            }
            else{
                pieceBytesRemaining -= bytesRemaining;
                len += bytesRemaining;
                bytesRemaining = 0;
                record = {name: file.path, offset: offset, len: len};
                len = 0;
            }
            if(pm[i-1] === undefined){
                pm[i-1] = [record];
            }else{
                pm[i-1].push(record);
            }
        }     
    }

    makeReadable(bdict){
        for(let p of ['announce', 'created by', 'comment']){
            if(bdict[p]){
                bdict[p] = bdict[p].toString(this.encoding);
            }
        }
        if(bdict.info && bdict.info.name){
            bdict.info.name = bdict.info.name.toString(this.encoding);
        }
        if(bdict.info && bdict.info.files){
            let files = bdict.info.files;
            for(let f of files){
                let p = [];
                p = f.path.map(x => x.toString(this.encoding));
                f.path = p.join(path.sep);
            }
        }
        return bdict;
    }

    talkTracker(trackerUrl, bdict){
        let trackerSearchParams = new url.URLSearchParams();
        trackerSearchParams.append('peer_id', peerId);
        trackerSearchParams.append('port', 6881);
        trackerSearchParams.append('compact',0);
        trackerSearchParams.append('uploaded', 0);
        trackerSearchParams.append('downloaded', 0);
        trackerSearchParams.append('left',0);
        
        // //trackerSearchParams.append('event',0);
        trackerUrl.search = trackerSearchParams;
    
        //until the url module is fixed, and binary data can be entered in correctly, we need to do this
        let trackerUrlFixed = trackerUrl + '&info_hash=' + bdict.infoChkSum;
        
        httpRequest(trackerUrlFixed, function(rawData){
            try {
                let j = bencode.decode(Buffer.concat(rawData));
                if(j['failure reason']){
                    throw new Error(j['failure reason'].toString());
                }
                if(checkReturnType(j)){
                    console.log(prettyFormat(parseLong(j)));
                }
                else{
                    console.log(prettyFormat(parseCompact(j)));
                }
            } catch (e) {
            console.log(e);
            }
        })
    }

    scrapeTracker(trackerUrl, bdict, infoHash){
        let original = trackerUrl.toString();
        let scrape = original.replace('/announce','/scrape');
    
        if(original === scrape){
            throw new Error("Not a scrapable tracker");
        }
    
        if(infoHash){
            scrape = scrape + '?info_hash=' + bdict.infoChkSum;
        }
    
        httpRequest(scrape, function (rawData, encoding){
            try {
                let j = bencode.decode(Buffer.concat(rawData));
                let files = [];
                for(let k of Object.keys(j.files)){
                    let filename = Buffer.from(k).toString('hex');
                    let obj = {};
                    obj[filename] = j.files[k];
                    files.push(obj);
                }
                console.log(prettyFormat(files));
            } catch (e) {
                console.log(e);
            }
        });
    }

    handShakeMsg(infoHash, peerId){
        let handShakeMsg = [];
        handShakeMsg.push(Buffer.from([19]));
        handShakeMsg.push(Buffer.from('BitTorrent protocol'));
        handShakeMsg.push(Buffer.from([0,0,0,0,0,0,0,0]));
        handShakeMsg.push(infoHash);
        handShakeMsg.push(Buffer.from(peerId));
        return Buffer.concat(handShakeMsg); 
    }
    
    handShake(infoHash){
      
        let host = 'localhost';
        let port = 6881;
        let raw = Buffer.alloc(0);
        let state = HANDSHAKE;
        let startTime;
        let lastKeepAlive;
        let pidExpected = Buffer.from([45,66,84,55,97,53,83,45,0,177,224,237,201,111,150,222,52,141,47,45]);
        let pstrlen;
        let pstr;
        let ih;
        let peerid;
        let cl;
        let peerBitField;
        
        let amChoking = true;
        let amUninterested = true;
        let peerChoking = true;
        let peerUninterested = true;
    
        let peerRequests = [];
    
        const client = this.client = net.createConnection({port: port, host:host, timeout:PEER_TIME_OUT}, () => {
            console.log(`connected to ${host}:${port}`);
            client.write(this.handShakeMsg(infoHash, peerId));
        });
        client.on('data', (data) => {
            raw = Buffer.concat([raw, data]);   
    
            while(true){ //waiting on more data state
            switch(state){
                case HANDSHAKE: //Handshake
                    
                    if(pstrlen === undefined){
                        pstrlen = raw[0];
                    }
                    if(raw.byteLength >= pstrlen+49){
                        let pos = 1;
                        pstr = raw.slice(pos,pstrlen+pos);
                        pos += pstrlen + 8;
                        ih = raw.slice(pos,pos+20);
                        pos += 20;
                        peerid = raw.slice(pos,pos+20);
                        pos += 20;
                        raw = raw.slice(pos);
    
                        if(pstr.toString() !== "BitTorrent protocol"){
                            throw new Error(pstr.toString());
                        }
                        
                        //disabled for testing, restore later
                        //if(peerid.equals(pidExpected) && ih.equals(infoHash)){
                        if(ih.equals(infoHash)){
                            state = READ_CMD_LEN;
                        }else{
                            throw new Error("peerid or infohash did not match with what was provided");
                        }
                    }else{
                        return;
                    }
                    break;
                    
                case READ_CMD_LEN: 
                    //Read next command's length
                    //length prefix is a four byte big-endian value = length of (message id + payload)
                    //message ID is a single decimal byte 
                    
                    if(raw.byteLength >= 4){
                        cl = parseInt(raw.slice(0,4).toString('hex'), 16);
                        raw = raw.slice(4);
                        state = READ_CMD_ID;
                    }else{
                        return;
                    }
                    break;
    
                case READ_CMD_ID:
                    if(!cl){
                        // command length of zero = keep alive message
                        timeout = 60*2000; 
                        state = READ_CMD_LEN;
                        console.log("keep alive");
                        break;
                    }
    
                    if(raw.byteLength >= cl){
                        state = raw[0];
                        raw = raw.slice(1);
                        cl-=1; //now set to payload length 
                    }
                    else{
                        return; 
                    }
                    break;
    
                case BIT_FIELD: //Bitfield
                    peerBitField = raw.slice(0,cl);
                    if(peerBitField.length !== torrentBitFields[this.filename]){
                        throw new Error("Peer sent invalid bitfield.");
                    }
                    raw = raw.slice(cl);
                    
                    this.sendBitField();
                    this.currentBlock = this.nextBlock();
                    this.requestPiece();
                    state = READ_CMD_LEN;
                    break;
    
                case HAVE: //Have message 
                    let index = parseInt(raw.slice(0,cl).toString('hex'), 16);
                    raw = raw.slice(cl);
                    this.updateBitField(index);
                    state = READ_CMD_LEN;
                    break;
                
                case CHOKE:
                    peerChoking = true;
                    state = READ_CMD_LEN;
                    break;
    
                case UNCHOKE:
                    peerChoking = false;
                    state = READ_CMD_LEN;
                    break;
                
                case INTERESTED:
                    peerUninterested = false;
                    state = READ_CMD_LEN;
                    break;
                
                    case UNINTERESTED:
                    peerUninterested = true;
                    state = READ_CMD_LEN;
                    break;
                
                case REQUEST:
                    let i,s,l;
                    i = parseInt(raw.slice(0, 4).toString('hex'), 16);
                    s = parseInt(raw.slice(4, 8).toString('hex'), 16);
                    l = parseInt(raw.slice(8, 12).toString('hex'), 16);
                    raw = raw.slice(12);
                    peerRequests.push({i:i, s:s, l:l});
                    state = READ_CMD_LEN;
                    break;
                
                // case PIECE:
                //     let i,s,block;
                //     i = parseInt(raw.slice(0, 4).toString('hex'), 16);
                //     s = parseInt(raw.slice(4, 8).toString('hex'), 16);
                //     block = raw.slice(8, cl);
                //     raw = raw.slice(cl);
    
                // case CANCEL:
                //     let i,s,l;
                //     i = parseInt(raw.slice(0, 4).toString('hex'), 16);
                //     s = parseInt(raw.slice(4, 8).toString('hex'), 16);
                //     l = parseInt(raw.slice(8, 12).toString('hex'), 16);
                //     raw = raw.slice(12);
                
                // default:
                //     state = READ_CMD_LEN;
                //     break;
                
            }
            }
          

        });
        client.on('end', () => {
            console.log('disconnected from server');
        });
        client.on('timeout', () => {
            console.log('socket timeout');
            client.end();
        });
        client.on('error', (e) => {
            console.error(e);
        })
    }  

    sendBitField(){
        let bitfield = torrentBitFields[this.filename];
        let msg = Buffer.alloc(bitfield.length + 5); // 5 = 4 bytes for length + 1 byte for id
        msg.writeInt32BE(1+bitfield.length);
        msg[4] = BIT_FIELD;
        bitfield.copy(msg,5); 
        this.client.write(msg);
    }
    
    //TODO: Set on time so if piece never comes we can retrigger request.
    requestPiece(){
        //request: <len=0013><id=6><index><begin><length>
        //find an available block or use existing we are currently working with
        //request block using stored index and offset

        let msg = Buffer.alloc(13);
        msg[0] = REQUEST;
        msg.writeInt32BE(this.currentBlock, 1);
        msg.writeInt32BE(this.blockOffset, 5);
        msg.writeInt32BE(this.blockReqLen, 9);
        this.client.write(msg);

    }

    nextBlock(){
        //when df has an index which is 1 then bf _always_ has same index zero
        let bf = torrentBitFields[this.filename];
        let df = dlBitFields[this.filename];
        let interestedBlocks = bitwise.buffer.and(bitwise.buffer.not(bf), this.peerBitField);
        let available = bitwise.buffer.xor(interestedBlocks, df) 
        for(let bi=0; bi<available.byteLength; bi++){
            let byte = available[bi];
            for(let i=0; i<8; i++){
                if(bitwise.integer.getBit(byte, i)){
                    bitwise.integer.setBit(df[bi], i); // lock bit
                    return i;
                }
            }
        }
    }

    updateBitField(index){
        let byte_i = Math.floor(index / 8);
        let bit_i = index % 8;
        let bitfield = torrentBitFields[this.filename];
        bitfield[byte_i] |= (1 << 7) >>> bit_i;
    }
}

t = new Torrent('Richie Hayward - 1991-11-11 Club Loonies, Nijmegen, Holland [TTD].torrent');
t.readFile();
