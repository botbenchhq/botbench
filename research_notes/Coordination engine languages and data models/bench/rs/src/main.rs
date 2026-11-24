use std::io::{Read,Write};use std::os::unix::net::UnixStream;
fn main(){let mut b=Vec::new();std::io::stdin().read_to_end(&mut b).unwrap();
let v: &str = std::str::from_utf8(&b).unwrap(); let _ = v.len(); b.push(b'\n');
let mut s=UnixStream::connect(std::env::var("SOCK").unwrap()).unwrap();s.write_all(&b).unwrap();
let mut r=String::new();s.read_to_string(&mut r).unwrap();print!("{}",r);}
