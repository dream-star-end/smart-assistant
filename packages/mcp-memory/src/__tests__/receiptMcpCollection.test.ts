import {test} from 'node:test'
import assert from 'node:assert/strict'
import {parseReceiptLocatorCollection} from '../receiptCliTransport.js'
const a={jobId:'dlgjob-a',generation:0,receiptNonce:'a'.repeat(64)}
const b={jobId:'dlgjob-b',generation:0,receiptNonce:'b'.repeat(64)}
test('bounded batch candidates deduplicate exact identity without dropping valid siblings',()=>{
 assert.deepEqual(parseReceiptLocatorCollection([a,a,{bad:true},b]),{locators:[a,b],invalid:true})
 assert.deepEqual(parseReceiptLocatorCollection([a,b]),{locators:[a,b],invalid:false})
})
test('conflicting same-job nonce fails closed without losing a different job',()=>{
 assert.deepEqual(parseReceiptLocatorCollection([a,{...a,receiptNonce:'c'.repeat(64)},b]),{locators:[b],invalid:true})
})
test('bad envelope and over-limit collection are never silently truncated',()=>{
 for(const value of [null,{},'[]',[a,a,a,a,a]])assert.deepEqual(parseReceiptLocatorCollection(value),{locators:[],invalid:true})
 assert.deepEqual(parseReceiptLocatorCollection([]),{locators:[],invalid:false})
})
