use crate::Error;

pub(crate) fn put_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

pub(crate) fn put_varint(out: &mut Vec<u8>, mut value: u64) {
    while value >= 0x80 {
        out.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

pub(crate) fn put_string(out: &mut Vec<u8>, value: &str) -> Result<(), Error> {
    put_varint(out, u64::try_from(value.len())?);
    out.extend_from_slice(value.as_bytes());
    Ok(())
}

pub(crate) struct Cursor<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> Cursor<'a> {
    pub(crate) const fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    pub(crate) fn take(&mut self, len: usize) -> Result<&'a [u8], Error> {
        let end = self.position.checked_add(len).ok_or(Error::Truncated)?;
        let value = self.bytes.get(self.position..end).ok_or(Error::Truncated)?;
        self.position = end;
        Ok(value)
    }

    pub(crate) fn array<const N: usize>(&mut self) -> Result<[u8; N], Error> {
        let mut out = [0_u8; N];
        out.copy_from_slice(self.take(N)?);
        Ok(out)
    }

    pub(crate) fn byte(&mut self) -> Result<u8, Error> {
        let value = *self.bytes.get(self.position).ok_or(Error::Truncated)?;
        self.position += 1;
        Ok(value)
    }

    pub(crate) fn u16(&mut self) -> Result<u16, Error> {
        Ok(u16::from_le_bytes(self.array()?))
    }

    pub(crate) fn u32(&mut self) -> Result<u32, Error> {
        Ok(u32::from_le_bytes(self.array()?))
    }

    pub(crate) fn u64_usize(&mut self) -> Result<usize, Error> {
        Ok(usize::try_from(u64::from_le_bytes(self.array()?))?)
    }

    pub(crate) fn varint_u32(&mut self) -> Result<u32, Error> {
        Ok(u32::try_from(self.varint()?)?)
    }

    pub(crate) fn varint_usize(&mut self) -> Result<usize, Error> {
        Ok(usize::try_from(self.varint()?)?)
    }

    fn varint(&mut self) -> Result<u64, Error> {
        let mut value = 0_u64;
        for shift in (0..=63).step_by(7) {
            let byte = self.byte()?;
            let payload = u64::from(byte & 0x7f);
            if shift == 63 && payload > 1 {
                return Err(Error::Corrupt("varint overflow"));
            }
            value |= payload << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err(Error::Corrupt("varint overflow"))
    }

    pub(crate) fn string(&mut self) -> Result<String, Error> {
        let len = self.varint_usize()?;
        Ok(std::str::from_utf8(self.take(len)?)?.to_string())
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.position == self.bytes.len()
    }
}
