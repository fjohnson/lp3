const crypto = require('crypto');
const prettyFormat = require('pretty-format');
const bencode = require('bencode');
const fs = require('fs');
const http = require('http');
const url = require('url');
const net = require('net');

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

function makeReadable(bdict){
    for(let p of ['announce', 'created by', 'comment']){
        if(bdict[p]){
            bdict[p] = bdict[p].toString(defaultEncoding);
        }
    }
    if(bdict.info && bdict.info.name){
        bdict.info.name = bdict.info.name.toString(defaultEncoding);
    }
    return bdict
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
            console.log('okay!');
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
    }

    readFile(){
        //archlinux-2019.08.01-x86_64.iso.torrent')//'tab2019-08-10-m21 (flac24).torrent')
        //'Richie Hayward - 1991-11-11 Club Loonies, Nijmegen, Holland [TTD].torrent'
        fs.promises.readFile(this.filename)
        .then((data)=>{

            this.bdict = bencode.decode(data);
            this.bdict = makeReadable(this.bdict);

            let infoVal = getInfoSha1(bencode.encode(this.bdict.info));
            this.bdict.infoChkSum = escapeBinary(infoVal);
            this.bdict.info.piecesChkSum = (getPiecesHash(this.bdict.info.pieces, this.bdict.encoding));
            
            let trackerUrl = new url.URL(this.bdict.announce);
            
            //scrapeTracker(trackerUrl, bdict, bdict.infoChkSum);
            //talkTracker(trackerUrl, bdict);
            //handShake(infoVal);
        })
        .catch((error)=>{
            console.log(error);
        });
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
        let startTime = ;
        let lastKeepAlive = ;
        let pidExpected = Buffer.from([45,66,84,55,97,53,83,45,0,177,224,237,201,111,150,222,52,141,47,45]);
        let pstrlen;
        let pstr;
        let ih;
        let peerid;
        let cl;
        let bitfield;
        
        let amChoking = true;
        let amUninterested = true;
        let peerChoking = true;
        let peerUninterested = true;
    
        let peerRequests = [];
    
        const client = net.createConnection({port: port, host:host, timeout:PEER_TIME_OUT}, () => {
            console.log(`connected to ${host}:${port}`);
            client.write(handShakeMsg(infoHash, peerId));
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
                            let out = pstr.toString();
                            console.error(`Unknown protocol: ${out}`)
                            client.end();
                        }
    
                        if(peerid.equals(pidExpected) && ih.equals(infoHash)){
                            state = READ_CMD_LEN;
                        }else{
                            console.error("peerid or infohash did not match with what was provided");
                            client.end();
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
                        cl-=1; //payload length 
                    }
                    else{
                        return; 
                    }
                    break;
    
                case BIT_FIELD: //Bitfield
                    bitfield = raw.slice(0,cl);
                    raw = raw.slice(cl);
                    state = READ_CMD_LEN;
                    //request piece here
                    break;
    
                case HAVE: //Have message 
                    index = parseInt(raw.slice(0,cl).toString('hex'), 16);
                    raw = raw.slice(cl);
                    bitfield = updateBitField(index, bitfield);
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
            
            function requestPiece(){
    
            }
        });
        client.on('end', () => {
            console.log('disconnected from server');
        });
        client.on('timeout', () => {
            console.log('socket timeout');
            client.end();
        });
    }  

    updateBitField(index, bitfield){
        byte_i = Math.floor(index / 8);
        bit_i = index % 8;
        bitfield[byte_i] |= (1 << 7) >>> bit_i;
        return bitfield;
    }
}
