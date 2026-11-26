import {describe,it,expect} from 'vitest';
import {parseImportedTickerResponse,parseTickerResponse} from '../api/clientSchemas';
const row={company:'Old employer',title:'Engineer',posted_at:null,added_at:'2026-11-26T10:00:00Z',logo_url:null};
describe('imported ticker parser',()=>{
 it('keeps independent clocks, nullable employer date, array and envelope',()=>{
  expect(parseImportedTickerResponse([row])).toEqual([row]);
  expect(parseImportedTickerResponse({jobs:[row]})).toEqual([row]);
  expect(parseTickerResponse([row])).toEqual([]);
 });
 it('does not borrow posted_at and rejects malformed import payload',()=>{
  expect(parseImportedTickerResponse([{...row,added_at:undefined,posted_at:'2026-11-26T10:00:00Z'},null,{...row,logo_url:1},{...row,posted_at:undefined},{...row,title:3}])).toEqual([]);
  expect(parseImportedTickerResponse({jobs:'bad'})).toEqual([]);
 });
});
