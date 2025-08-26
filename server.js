require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');
const cors = require('cors');
const axios = require('axios');
const app = express();
app.use(express.json());
app.use(cors());

// CoinMarketCap API configuration
const CMC_API_KEY = process.env.CMC_API_KEY || '';
const CMC_BASE_URL = 'https://pro-api.coinmarketcap.com/v1';

const NETWORKS = {
  sepolia: process.env.SEPOLIA_URL,
  mainnet: process.env.MAINNET_URL || 'https://mainnet.infura.io/v3/YOUR_PROJECT_ID'
};

function getProvider(network) {
  return new ethers.JsonRpcProvider(NETWORKS[network] || NETWORKS.sepolia);
}


// Create a new random wallet
app.post('/create-wallet', (req, res) => {
  const wallet = ethers.Wallet.createRandom();
  res.json({ address: wallet.address, privateKey: wallet.privateKey });
});

// Connect to an existing wallet
app.post('/connect-wallet', (req, res) => {
  try {
    const { privateKey } = req.body;
    const wallet = new ethers.Wallet(privateKey);
    res.json({ address: wallet.address });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});


// Get balance for address on selected network
app.post('/balance', async (req, res) => {
  try {
    const { address, network } = req.body;
    const provider = getProvider(network);
    const balance = await provider.getBalance(address);
    res.json({ balance: ethers.formatEther(balance) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});


// Send transaction between wallets on selected network
app.post('/send', async (req, res) => {
  try {
    const { fromPrivateKey, to, value, network } = req.body;
    const provider = getProvider(network);
    const wallet = new ethers.Wallet(fromPrivateKey || process.env.PRIVATE_KEY, provider);
    const tx = await wallet.sendTransaction({ to, value: ethers.parseEther(value) });
    await tx.wait();
    res.json({ hash: tx.hash });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Gemini API analysis endpoint
app.post('/gemini-analyze', async (req, res) => {
  try {
    const { prompt } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;
    const response = await axios.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent',
      { contents: [{ parts: [{ text: prompt }] }] },
      { headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey } }
    );
    res.json({ result: response.data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Ethereum price endpoint - fetch from real API sources simultaneously
app.get('/eth-price', async (req, res) => {
  try {
    // Result object with real-time prices
    const result = {
      prices: {},
      lastUpdated: new Date().toISOString(),
      errors: []
    };
    
    // Promise array for parallel API requests
    const pricePromises = [];
    
    // CoinMarketCap request
    if (CMC_API_KEY) {
      const cmcPromise = axios.get(`${CMC_BASE_URL}/cryptocurrency/quotes/latest`, {
        params: {
          symbol: 'ETH',
          convert: 'USD'
        },
        headers: {
          'X-CMC_PRO_API_KEY': CMC_API_KEY
        },
        timeout: 10000
      })
      .then(response => {
        if (response.data && response.data.data && response.data.data.ETH) {
          const ethData = response.data.data.ETH;
          result.prices.coinmarketcap = ethData.quote.USD.price;
          console.log("CoinMarketCap API call successful");
        }
      })
      .catch(err => {
        console.error("CoinMarketCap API error:", err.message);
        result.errors.push("CoinMarketCap: " + err.message);
      });
      
      pricePromises.push(cmcPromise);
    }
    
    // CoinGecko request - use free public API
    const cgPromise = axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: {
        ids: 'ethereum',
        vs_currencies: 'usd'
      },
      timeout: 10000,
      headers: { 'Accept': 'application/json', 'Accept-Encoding': 'deflate, gzip' }
    })
    .then(response => {
      if (response.data && response.data.ethereum && response.data.ethereum.usd) {
        result.prices.coingecko = response.data.ethereum.usd;
        console.log("CoinGecko API call successful");
      }
    })
    .catch(err => {
      console.error("CoinGecko API error:", err.message);
      result.errors.push("CoinGecko: " + err.message);
    });
    
    pricePromises.push(cgPromise);
    
    // Wait for all price requests to complete or timeout
    await Promise.allSettled(pricePromises);
    
    // Only return real-time data
    console.log("Real-time prices fetched:", result);
    
    if (Object.keys(result.prices).length === 0) {
      // If no APIs worked, return a clear error
      return res.status(503).json({ 
        error: "No real-time price data available. APIs may be down or rate-limited.",
        errors: result.errors
      });
    }
    
    res.json(result);
    
  } catch (err) {
    console.error("Price fetch error:", err.message);
    res.status(500).json({ 
      error: err.message
    });
  }
});

// Real-time ETH market data from multiple sources
app.get('/eth-market', async (req, res) => {
  try {
    // Try to fetch from multiple sources and merge data
    const errors = [];
    
    // Try to fetch from CoinGecko first
    try {
      const url = 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true';
      
      const response = await axios.get(url, { 
        timeout: 10000,
        headers: { 'Accept': 'application/json', 'Accept-Encoding': 'deflate, gzip' }
      });
      
      if (response.data && response.data.ethereum) {
        const ethData = response.data.ethereum;
        
        // Structure basic real-time stats
        const market = {
          name: "Ethereum",
          symbol: "ETH",
          price: ethData.usd,
          market_cap: ethData.usd_market_cap,
          volume_24h: ethData.usd_24h_vol,
          price_change_24h: ethData.usd_24h_change,
          last_updated: new Date(ethData.last_updated_at * 1000).toISOString(),
          source: 'coingecko'
        };
        
        console.log("CoinGecko market data API call successful");
        return res.json(market);
      }
    } catch (cgErr) {
      console.error("CoinGecko market data API error:", cgErr.message);
      errors.push("CoinGecko: " + cgErr.message);
    }
    
    // If CoinGecko fails, try CMC if we have an API key
    if (CMC_API_KEY) {
      try {
        const response = await axios.get(`${CMC_BASE_URL}/cryptocurrency/quotes/latest`, {
          params: {
            symbol: 'ETH',
            convert: 'USD'
          },
          headers: {
            'X-CMC_PRO_API_KEY': CMC_API_KEY
          },
          timeout: 10000
        });
        
        if (response.data && response.data.data && response.data.data.ETH) {
          const ethData = response.data.data.ETH;
          const quoteData = ethData.quote.USD;
          
          const market = {
            name: "Ethereum",
            symbol: "ETH",
            price: quoteData.price,
            market_cap: quoteData.market_cap,
            volume_24h: quoteData.volume_24h,
            price_change_24h: quoteData.percent_change_24h,
            last_updated: new Date(ethData.last_updated).toISOString(),
            source: 'coinmarketcap'
          };
          
          console.log("CoinMarketCap market data API call successful");
          return res.json(market);
        }
      } catch (cmcErr) {
        console.error("CoinMarketCap market data API error:", cmcErr.message);
        errors.push("CoinMarketCap: " + cmcErr.message);
      }
    }
    
    // If all real-time sources fail, return an error
    console.error("All ETH market data sources failed");
    res.status(503).json({ 
      error: "No real-time market data available. APIs may be down or rate-limited.",
      errors: errors
    });
  } catch (err) {
    console.error("ETH market data error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Gemini analysis of real market data
app.get('/eth-market-analyze', async (req, res) => {
  try {
    // First get real-time market data
    let marketData = null;
    const errors = [];
    
    // Try CoinGecko first
    try {
      const cgUrl = 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true';
      const cgResponse = await axios.get(cgUrl, {
        timeout: 10000,
        headers: { 'Accept': 'application/json', 'Accept-Encoding': 'deflate, gzip' }
      });
      
      if (cgResponse.data && cgResponse.data.ethereum) {
        const ethData = cgResponse.data.ethereum;
        marketData = {
          name: "Ethereum",
          symbol: "ETH",
          price: ethData.usd,
          market_cap: ethData.usd_market_cap,
          volume_24h: ethData.usd_24h_vol,
          price_change_24h: ethData.usd_24h_change,
          last_updated: new Date(ethData.last_updated_at * 1000).toISOString(),
          source: 'coingecko'
        };
        console.log("CoinGecko market data API call successful for analysis");
      }
    } catch (cgErr) {
      console.error("CoinGecko API error for analysis:", cgErr.message);
      errors.push("CoinGecko: " + cgErr.message);
    }
    
    // If CoinGecko fails, try CoinMarketCap
    if (!marketData && CMC_API_KEY) {
      try {
        const cmcResponse = await axios.get(`${CMC_BASE_URL}/cryptocurrency/quotes/latest`, {
          params: {
            symbol: 'ETH',
            convert: 'USD'
          },
          headers: {
            'X-CMC_PRO_API_KEY': CMC_API_KEY
          },
          timeout: 10000
        });
        
        if (cmcResponse.data && cmcResponse.data.data && cmcResponse.data.data.ETH) {
          const ethData = cmcResponse.data.data.ETH;
          const quoteData = ethData.quote.USD;
          
          marketData = {
            name: "Ethereum",
            symbol: "ETH",
            price: quoteData.price,
            market_cap: quoteData.market_cap,
            volume_24h: quoteData.volume_24h,
            price_change_24h: quoteData.percent_change_24h,
            last_updated: new Date(ethData.last_updated).toISOString(),
            source: 'coinmarketcap'
          };
          console.log("CoinMarketCap market data API call successful for analysis");
        }
      } catch (cmcErr) {
        console.error("CoinMarketCap API error for analysis:", cmcErr.message);
        errors.push("CoinMarketCap: " + cmcErr.message);
      }
    }
    
    if (!marketData) {
      return res.status(503).json({ 
        error: "No real-time market data available for analysis. APIs may be down or rate-limited.",
        errors: errors
      });
    }
    
    // Get Gemini analysis based on real-time data
    try {
      const geminiApiKey = process.env.GEMINI_API_KEY;
      if (!geminiApiKey) {
        return res.json({ 
          market: marketData, 
          analysis: { 
            text: "No Gemini API key provided. Please add GEMINI_API_KEY to your .env file to get AI analysis." 
          }
        });
      }
      
      // More detailed prompt to get better analysis of real-time data
      const prompt = `
      Analyze this real-time Ethereum market data:
      
      Price: $${marketData.price.toLocaleString()}
      24h Change: ${marketData.price_change_24h.toFixed(2)}%
      Market Cap: $${marketData.market_cap.toLocaleString()}
      24h Volume: $${marketData.volume_24h.toLocaleString()}
      Data Source: ${marketData.source}
      Last Updated: ${marketData.last_updated}
      
      Provide a precise, data-driven trading analysis in 2-3 sentences about the current Ethereum market conditions based ONLY on this real-time data.
      `;
      
      const geminiRes = await axios.post(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent',
        { contents: [{ parts: [{ text: prompt }] }] },
        { 
          headers: { 
            'Content-Type': 'application/json', 
            'x-goog-api-key': geminiApiKey 
          },
          timeout: 15000
        }
      );
      
      // Extract the text content from the Gemini response
      let analysisText = "";
      if (geminiRes.data && geminiRes.data.candidates && geminiRes.data.candidates[0] && 
          geminiRes.data.candidates[0].content && geminiRes.data.candidates[0].content.parts && 
          geminiRes.data.candidates[0].content.parts[0].text) {
        analysisText = geminiRes.data.candidates[0].content.parts[0].text;
      } else {
        analysisText = "Analysis not available from Gemini API response";
      }
      
      console.log("Gemini analysis generated for real-time ETH market data");
      res.json({ 
        market: marketData, 
        analysis: { 
          text: analysisText,
          source: "gemini",
          basedOn: "real-time-data"
        }
      });
      
    } catch (err) {
      console.error("Gemini API error:", err.message);
      
      // Provide basic analysis if Gemini fails, but clearly label it as fallback
      let analysisText = "";
      if (marketData.price_change_24h > 2) {
        analysisText = "Ethereum shows bullish momentum with significant price increase over 24h.";
      } else if (marketData.price_change_24h > 0) {
        analysisText = "Ethereum shows modest gains with slightly positive momentum.";
      } else if (marketData.price_change_24h > -2) {
        analysisText = "Ethereum shows minor bearish sentiment with a slight price decrease.";
      } else {
        analysisText = "Ethereum shows notable bearish momentum with significant price decline.";
      }
      
      res.json({ 
        market: marketData, 
        analysis: { 
          text: analysisText + " (This is a basic fallback analysis as Gemini API request failed)",
          source: "fallback",
          basedOn: "real-time-data"
        },
        error: "Gemini API error: " + err.message
      });
    }
  } catch (err) {
    console.error("Analysis error:", err.message);
    res.status(500).json({ error: "Failed to analyze Ethereum data: " + err.message });
  }
});

app.listen(3000, () => console.log('Server running on port 3000'));
